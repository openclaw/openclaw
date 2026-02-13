"""Auth profile store with file locking."""

import json
from pathlib import Path
from typing import Callable

from filelock import FileLock, Timeout

from openclaw_py.logging import log_debug, log_info, log_warn
from openclaw_py.utils.common import safe_parse_json

from .constants import (
    AUTH_STORE_LOCK_TIMEOUT,
    AUTH_STORE_VERSION,
)
from .external_cli_sync import sync_external_cli_credentials
from .paths import (
    ensure_auth_store_file,
    resolve_auth_store_path,
    resolve_legacy_auth_store_path,
)
from .types import (
    ApiKeyCredential,
    AuthProfileCredential,
    AuthProfileStore,
    OAuthCredential,
    ProfileUsageStats,
    TokenCredential,
)


def _load_json_file(path: Path) -> dict | None:
    """Load JSON file safely.

    Args:
        path: Path to JSON file

    Returns:
        Parsed JSON dict or None if file doesn't exist or parse fails
    """
    if not path.exists():
        return None

    try:
        content = path.read_text(encoding="utf-8")
        return safe_parse_json(content)
    except Exception:
        return None


def _save_json_file(path: Path, data: dict) -> None:
    """Save JSON file.

    Args:
        path: Path to JSON file
        data: Data to save
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(data, indent=2, ensure_ascii=False)
    path.write_text(content, encoding="utf-8")


def _coerce_legacy_store(raw: dict) -> dict[str, AuthProfileCredential] | None:
    """Coerce legacy auth.json format to new format.

    Args:
        raw: Raw JSON data

    Returns:
        Dict of profile_id -> credential, or None if not legacy format
    """
    if not raw or not isinstance(raw, dict):
        return None

    # New format has "profiles" key
    if "profiles" in raw:
        return None

    entries: dict[str, AuthProfileCredential] = {}

    for key, value in raw.items():
        if not value or not isinstance(value, dict):
            continue

        cred_type = value.get("type")
        if cred_type not in ("api_key", "token", "oauth"):
            continue

        provider = str(value.get("provider", key))

        if cred_type == "api_key":
            entries[key] = ApiKeyCredential(
                type="api_key",
                provider=provider,
                key=value.get("key"),
                email=value.get("email"),
            )
        elif cred_type == "token":
            entries[key] = TokenCredential(
                type="token",
                provider=provider,
                token=value["token"],
                expires=value.get("expires"),
                email=value.get("email"),
            )
        else:  # oauth
            entries[key] = OAuthCredential(
                type="oauth",
                provider=provider,
                access=value["access"],
                refresh=value.get("refresh"),
                expires=value.get("expires"),
                enterprise_url=value.get("enterpriseUrl"),
                project_id=value.get("projectId"),
                account_id=value.get("accountId"),
                email=value.get("email"),
            )

    return entries if entries else None


def _coerce_auth_store(raw: dict) -> AuthProfileStore | None:
    """Coerce raw JSON to AuthProfileStore.

    Args:
        raw: Raw JSON data

    Returns:
        AuthProfileStore or None if invalid format
    """
    if not raw or not isinstance(raw, dict):
        return None

    profiles_raw = raw.get("profiles")
    if not profiles_raw or not isinstance(profiles_raw, dict):
        return None

    profiles: dict[str, AuthProfileCredential] = {}

    for key, value in profiles_raw.items():
        if not value or not isinstance(value, dict):
            continue

        cred_type = value.get("type")
        if cred_type not in ("api_key", "token", "oauth"):
            continue

        provider = value.get("provider")
        if not provider:
            continue

        try:
            if cred_type == "api_key":
                profiles[key] = ApiKeyCredential(**value)
            elif cred_type == "token":
                profiles[key] = TokenCredential(**value)
            else:  # oauth
                profiles[key] = OAuthCredential(**value)
        except Exception:
            continue

    # Parse order
    order_raw = raw.get("order")
    order: dict[str, list[str]] | None = None
    if order_raw and isinstance(order_raw, dict):
        order = {}
        for provider, value in order_raw.items():
            if isinstance(value, list):
                filtered = [str(v).strip() for v in value if v]
                if filtered:
                    order[provider] = filtered

    # Parse lastGood
    last_good_raw = raw.get("lastGood")
    last_good = last_good_raw if isinstance(last_good_raw, dict) else None

    # Parse usageStats
    usage_stats_raw = raw.get("usageStats")
    usage_stats: dict[str, ProfileUsageStats] | None = None
    if usage_stats_raw and isinstance(usage_stats_raw, dict):
        usage_stats = {}
        for profile_id, stats in usage_stats_raw.items():
            if isinstance(stats, dict):
                try:
                    usage_stats[profile_id] = ProfileUsageStats(**stats)
                except Exception:
                    continue

    return AuthProfileStore(
        version=int(raw.get("version", AUTH_STORE_VERSION)),
        profiles=profiles,
        order=order if order else None,
        last_good=last_good,
        usage_stats=usage_stats,
    )


def _merge_record(
    base: dict | None,
    override: dict | None,
) -> dict | None:
    """Merge two dicts, with override taking precedence.

    Args:
        base: Base dict
        override: Override dict

    Returns:
        Merged dict or None
    """
    if not base and not override:
        return None
    if not base:
        return {**override} if override else None
    if not override:
        return {**base}
    return {**base, **override}


def _merge_auth_profile_stores(
    base: AuthProfileStore,
    override: AuthProfileStore,
) -> AuthProfileStore:
    """Merge two auth profile stores.

    Args:
        base: Base store
        override: Override store

    Returns:
        Merged store
    """
    if (
        not override.profiles
        and not override.order
        and not override.last_good
        and not override.usage_stats
    ):
        return base

    return AuthProfileStore(
        version=max(base.version, override.version),
        profiles={**base.profiles, **override.profiles},
        order=_merge_record(base.order, override.order),  # type: ignore
        last_good=_merge_record(base.last_good, override.last_good),  # type: ignore
        usage_stats=_merge_record(base.usage_stats, override.usage_stats),  # type: ignore
    )


def load_auth_profile_store() -> AuthProfileStore:
    """Load auth profile store from default path.

    Returns:
        AuthProfileStore instance
    """
    return _load_auth_profile_store_for_agent(None)


def _load_auth_profile_store_for_agent(
    agent_dir: str | None,
) -> AuthProfileStore:
    """Load auth profile store for specific agent.

    Args:
        agent_dir: Optional agent directory

    Returns:
        AuthProfileStore instance
    """
    auth_path = resolve_auth_store_path(agent_dir)
    raw = _load_json_file(auth_path)
    as_store = _coerce_auth_store(raw) if raw else None

    if as_store:
        # Sync from external CLI tools on every load
        synced = sync_external_cli_credentials(as_store)
        if synced:
            _save_json_file(auth_path, as_store.model_dump(by_alias=True, exclude_none=True))
        return as_store

    # Fallback: inherit from main agent if subagent has none
    if agent_dir:
        main_auth_path = resolve_auth_store_path()  # without agentDir = main
        main_raw = _load_json_file(main_auth_path)
        main_store = _coerce_auth_store(main_raw) if main_raw else None
        if main_store and main_store.profiles:
            # Clone main store to subagent directory for auth inheritance
            _save_json_file(auth_path, main_store.model_dump(by_alias=True, exclude_none=True))
            log_info(f"inherited auth-profiles from main agent: agent_dir={agent_dir}")
            return main_store

    # Try legacy auth.json migration
    legacy_raw = _load_json_file(resolve_legacy_auth_store_path(agent_dir))
    legacy = _coerce_legacy_store(legacy_raw) if legacy_raw else None

    store = AuthProfileStore(version=AUTH_STORE_VERSION, profiles={})

    if legacy:
        for provider, cred in legacy.items():
            profile_id = f"{provider}:default"
            store.profiles[profile_id] = cred

    # Sync external CLI
    synced_cli = sync_external_cli_credentials(store)
    should_write = legacy is not None or synced_cli

    if should_write:
        _save_json_file(auth_path, store.model_dump(by_alias=True, exclude_none=True))

    # Delete legacy file after migration
    if should_write and legacy is not None:
        legacy_path = resolve_legacy_auth_store_path(agent_dir)
        try:
            legacy_path.unlink(missing_ok=True)
        except Exception as err:
            log_warn(f"failed to delete legacy auth.json after migration: {err}")

    return store


def ensure_auth_profile_store(agent_dir: str | None = None) -> AuthProfileStore:
    """Ensure auth profile store exists and load it.

    Args:
        agent_dir: Optional agent directory

    Returns:
        AuthProfileStore instance
    """
    store = _load_auth_profile_store_for_agent(agent_dir)
    auth_path = resolve_auth_store_path(agent_dir)
    main_auth_path = resolve_auth_store_path()

    if not agent_dir or auth_path == main_auth_path:
        return store

    # Merge with main store for subagents
    main_store = _load_auth_profile_store_for_agent(None)
    merged = _merge_auth_profile_stores(main_store, store)

    return merged


def save_auth_profile_store(store: AuthProfileStore, agent_dir: str | None = None) -> None:
    """Save auth profile store to disk.

    Args:
        store: AuthProfileStore to save
        agent_dir: Optional agent directory
    """
    auth_path = resolve_auth_store_path(agent_dir)
    payload = store.model_dump(by_alias=True, exclude_none=True)
    _save_json_file(auth_path, payload)
    log_debug(f"saved auth-profiles: {auth_path}")


async def update_auth_profile_store_with_lock(
    params: dict,
) -> AuthProfileStore | None:
    """Update auth profile store with file lock protection.

    Args:
        params: Dict with keys:
            - agent_dir: Optional agent directory
            - updater: Callable that takes AuthProfileStore and returns bool (should save)

    Returns:
        Updated AuthProfileStore or None if lock fails
    """
    agent_dir: str | None = params.get("agent_dir")
    updater: Callable[[AuthProfileStore], bool] = params["updater"]

    auth_path = resolve_auth_store_path(agent_dir)
    ensure_auth_store_file(auth_path)

    lock_path = auth_path.with_suffix(".lock")
    lock = FileLock(str(lock_path), timeout=AUTH_STORE_LOCK_TIMEOUT)

    try:
        with lock:
            store = ensure_auth_profile_store(agent_dir)
            should_save = updater(store)
            if should_save:
                save_auth_profile_store(store, agent_dir)
            return store
    except Timeout:
        log_warn(f"failed to acquire lock for auth store: {auth_path}")
        return None
    except Exception as e:
        log_warn(f"error updating auth store with lock: {e}")
        return None
