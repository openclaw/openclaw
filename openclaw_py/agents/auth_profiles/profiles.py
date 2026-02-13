"""Auth profile management operations."""

from openclaw_py.agents.model_selection import normalize_provider_id

from .store import (
    ensure_auth_profile_store,
    save_auth_profile_store,
    update_auth_profile_store_with_lock,
)
from .types import AuthProfileCredential, AuthProfileStore


def normalize_secret_input(secret: str) -> str:
    """Normalize secret input (trim whitespace).

    Args:
        secret: Secret string

    Returns:
        Normalized secret
    """
    return secret.strip()


async def set_auth_profile_order(
    provider: str,
    order: list[str] | None = None,
    agent_dir: str | None = None,
) -> AuthProfileStore | None:
    """Set auth profile order for a provider.

    Args:
        provider: Provider ID
        order: List of profile IDs in preferred order (None to clear)
        agent_dir: Optional agent directory

    Returns:
        Updated AuthProfileStore or None if failed
    """
    provider_key = normalize_provider_id(provider)

    # Deduplicate and filter
    sanitized = [str(entry).strip() for entry in (order or []) if entry]
    deduped: list[str] = []
    for entry in sanitized:
        if entry and entry not in deduped:
            deduped.append(entry)

    def updater(store: AuthProfileStore) -> bool:
        store.order = store.order or {}

        if not deduped:
            if provider_key not in store.order:
                return False
            del store.order[provider_key]
            if not store.order:
                store.order = None
            return True

        store.order[provider_key] = deduped
        return True

    return await update_auth_profile_store_with_lock(
        {"agent_dir": agent_dir, "updater": updater}
    )


def upsert_auth_profile(
    profile_id: str,
    credential: AuthProfileCredential,
    agent_dir: str | None = None,
) -> None:
    """Insert or update an auth profile.

    Args:
        profile_id: Profile ID
        credential: Credential to store
        agent_dir: Optional agent directory
    """
    # Normalize secrets
    if credential.type == "api_key" and credential.key:
        credential.key = normalize_secret_input(credential.key)
    elif credential.type == "token":
        credential.token = normalize_secret_input(credential.token)

    store = ensure_auth_profile_store(agent_dir)
    store.profiles[profile_id] = credential
    save_auth_profile_store(store, agent_dir)


def list_profiles_for_provider(store: AuthProfileStore, provider: str) -> list[str]:
    """List all profile IDs for a specific provider.

    Args:
        store: AuthProfileStore
        provider: Provider ID

    Returns:
        List of profile IDs

    Examples:
        >>> store = AuthProfileStore(profiles={"anthropic:default": ...})
        >>> list_profiles_for_provider(store, "anthropic")
        ['anthropic:default']
    """
    provider_key = normalize_provider_id(provider)
    return [
        profile_id
        for profile_id, cred in store.profiles.items()
        if normalize_provider_id(cred.provider) == provider_key
    ]


async def mark_auth_profile_good(
    store: AuthProfileStore,
    provider: str,
    profile_id: str,
    agent_dir: str | None = None,
) -> None:
    """Mark a profile as last known good for a provider.

    Args:
        store: AuthProfileStore
        provider: Provider ID
        profile_id: Profile ID to mark as good
        agent_dir: Optional agent directory
    """

    def updater(fresh_store: AuthProfileStore) -> bool:
        profile = fresh_store.profiles.get(profile_id)
        if not profile or profile.provider != provider:
            return False

        fresh_store.last_good = fresh_store.last_good or {}
        fresh_store.last_good[provider] = profile_id
        return True

    updated = await update_auth_profile_store_with_lock(
        {"agent_dir": agent_dir, "updater": updater}
    )

    if updated:
        store.last_good = updated.last_good
        return

    # Fallback: direct update if lock fails
    profile = store.profiles.get(profile_id)
    if not profile or profile.provider != provider:
        return

    store.last_good = store.last_good or {}
    store.last_good[provider] = profile_id
    save_auth_profile_store(store, agent_dir)
