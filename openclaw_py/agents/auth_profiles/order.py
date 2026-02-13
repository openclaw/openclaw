"""Auth profile ordering and round-robin selection."""

import time

from openclaw_py.agents.model_selection import normalize_provider_id
from openclaw_py.config import OpenClawConfig

from .profiles import list_profiles_for_provider
from .types import AuthProfileStore
from .usage import is_profile_in_cooldown


def _resolve_profile_unusable_until(stats: dict) -> int | None:
    """Resolve profile unusable until timestamp.

    Args:
        stats: Profile usage stats dict

    Returns:
        Timestamp (ms) or None
    """
    values = [
        stats.get("cooldownUntil") or stats.get("cooldown_until"),
        stats.get("disabledUntil") or stats.get("disabled_until"),
    ]
    valid_values = [v for v in values if isinstance(v, (int, float)) and v > 0]
    return int(max(valid_values)) if valid_values else None


def resolve_auth_profile_order(
    cfg: OpenClawConfig | None,
    store: AuthProfileStore,
    provider: str,
    preferred_profile: str | None = None,
) -> list[str]:
    """Resolve auth profile order for a provider.

    Applies round-robin rotation, cooldown sorting, and explicit order overrides.

    Args:
        cfg: OpenClaw configuration
        store: AuthProfileStore
        provider: Provider ID
        preferred_profile: Optional preferred profile (goes first)

    Returns:
        Ordered list of profile IDs

    Examples:
        >>> order = resolve_auth_profile_order(cfg, store, "anthropic")
        >>> order[0]  # First profile to try
        'anthropic:default'
    """
    provider_key = normalize_provider_id(provider)
    now = int(time.time() * 1000)  # ms

    # Check stored order (highest priority)
    stored_order: list[str] | None = None
    if store.order:
        for key, value in store.order.items():
            if normalize_provider_id(key) == provider_key:
                stored_order = value
                break

    # Check config order
    configured_order: list[str] | None = None
    if cfg and hasattr(cfg, "auth") and cfg.auth:
        auth_config = cfg.auth
        if hasattr(auth_config, "order") and auth_config.order:
            for key, value in auth_config.order.items():
                if normalize_provider_id(key) == provider_key:
                    configured_order = value
                    break

    explicit_order = stored_order or configured_order

    # Get explicit profiles from config
    explicit_profiles: list[str] = []
    if cfg and hasattr(cfg, "auth") and cfg.auth:
        auth_config = cfg.auth
        if hasattr(auth_config, "profiles") and auth_config.profiles:
            explicit_profiles = [
                profile_id
                for profile_id, profile in auth_config.profiles.items()
                if normalize_provider_id(profile.provider) == provider_key
            ]

    # Base order
    base_order = (
        explicit_order
        if explicit_order
        else (
            explicit_profiles
            if explicit_profiles
            else list_profiles_for_provider(store, provider_key)
        )
    )

    if not base_order:
        return []

    # Filter valid profiles
    filtered: list[str] = []
    for profile_id in base_order:
        cred = store.profiles.get(profile_id)
        if not cred:
            continue

        if normalize_provider_id(cred.provider) != provider_key:
            continue

        # Check config profile compatibility
        if cfg and hasattr(cfg, "auth") and cfg.auth:
            auth_config = cfg.auth
            if hasattr(auth_config, "profiles") and auth_config.profiles:
                profile_config = auth_config.profiles.get(profile_id)
                if profile_config:
                    if normalize_provider_id(profile_config.provider) != provider_key:
                        continue
                    # Check mode compatibility
                    if hasattr(profile_config, "mode"):
                        if profile_config.mode != cred.type:
                            # OAuth and token are compatible
                            oauth_compatible = (
                                profile_config.mode == "oauth" and cred.type == "token"
                            )
                            if not oauth_compatible:
                                continue

        # Validate credential
        if cred.type == "api_key":
            if not (cred.key and cred.key.strip()):
                continue
        elif cred.type == "token":
            if not (cred.token and cred.token.strip()):
                continue
            # Check expiry
            if cred.expires and cred.expires > 0 and now >= cred.expires:
                continue
        elif cred.type == "oauth":
            if not (cred.access and cred.access.strip()):
                if not (cred.refresh and cred.refresh.strip()):
                    continue

        filtered.append(profile_id)

    # Deduplicate
    deduped: list[str] = []
    for entry in filtered:
        if entry not in deduped:
            deduped.append(entry)

    # If explicit order was specified, apply cooldown sorting
    if explicit_order:
        available: list[str] = []
        in_cooldown: list[tuple[str, int]] = []

        for profile_id in deduped:
            stats = store.usage_stats.get(profile_id) if store.usage_stats else None
            cooldown_until = _resolve_profile_unusable_until(stats or {})

            if cooldown_until and now < cooldown_until:
                in_cooldown.append((profile_id, cooldown_until))
            else:
                available.append(profile_id)

        # Sort cooldown profiles by expiry (soonest first)
        cooldown_sorted = [pid for pid, _ in sorted(in_cooldown, key=lambda x: x[1])]
        ordered = available + cooldown_sorted

        # Put preferred profile first
        if preferred_profile and preferred_profile in ordered:
            ordered = [preferred_profile] + [p for p in ordered if p != preferred_profile]

        return ordered

    # Otherwise, use round-robin mode
    sorted_profiles = _order_profiles_by_mode(deduped, store)

    if preferred_profile and preferred_profile in sorted_profiles:
        sorted_profiles = [preferred_profile] + [
            p for p in sorted_profiles if p != preferred_profile
        ]

    return sorted_profiles


def _order_profiles_by_mode(order: list[str], store: AuthProfileStore) -> list[str]:
    """Order profiles by type preference and round-robin.

    Args:
        order: List of profile IDs
        store: AuthProfileStore

    Returns:
        Sorted list of profile IDs
    """
    now = int(time.time() * 1000)  # ms

    # Partition into available and in-cooldown
    available: list[str] = []
    in_cooldown_list: list[str] = []

    for profile_id in order:
        if is_profile_in_cooldown(store, profile_id):
            in_cooldown_list.append(profile_id)
        else:
            available.append(profile_id)

    # Score and sort available profiles
    scored: list[tuple[str, int, int]] = []
    for profile_id in available:
        cred = store.profiles.get(profile_id)
        if not cred:
            continue

        # Type preference: oauth (0) > token (1) > api_key (2)
        type_score = 0 if cred.type == "oauth" else (1 if cred.type == "token" else 2)

        # Last used (oldest first for round-robin)
        stats = store.usage_stats.get(profile_id) if store.usage_stats else None
        last_used = (
            stats.last_used
            if stats and hasattr(stats, "last_used") and stats.last_used
            else 0
        )

        scored.append((profile_id, type_score, last_used))

    # Sort by type (asc) then by lastUsed (asc = oldest first)
    sorted_available = [
        pid for pid, _, _ in sorted(scored, key=lambda x: (x[1], x[2]))
    ]

    # Sort cooldown profiles by expiry (soonest first)
    cooldown_with_expiry: list[tuple[str, int]] = []
    for profile_id in in_cooldown_list:
        stats = store.usage_stats.get(profile_id) if store.usage_stats else None
        cooldown_until = _resolve_profile_unusable_until(stats.model_dump() if stats else {})
        cooldown_with_expiry.append((profile_id, cooldown_until or now))

    cooldown_sorted = [
        pid for pid, _ in sorted(cooldown_with_expiry, key=lambda x: x[1])
    ]

    return sorted_available + cooldown_sorted
