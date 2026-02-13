"""Auth profile health checks."""

import time

from .types import AuthProfileStore


def check_profile_valid(store: AuthProfileStore, profile_id: str) -> bool:
    """Check if a profile is valid.

    Args:
        store: AuthProfileStore
        profile_id: Profile ID

    Returns:
        True if profile is valid
    """
    profile = store.profiles.get(profile_id)
    if not profile:
        return False

    now = int(time.time() * 1000)

    if profile.type == "api_key":
        return bool(profile.key and profile.key.strip())
    elif profile.type == "token":
        if not (profile.token and profile.token.strip()):
            return False
        # Check expiry
        if profile.expires and profile.expires > 0 and now >= profile.expires:
            return False
        return True
    elif profile.type == "oauth":
        return bool(
            (profile.access and profile.access.strip())
            or (profile.refresh and profile.refresh.strip())
        )

    return False


def check_profile_expired(store: AuthProfileStore, profile_id: str) -> bool:
    """Check if a profile is expired.

    Args:
        store: AuthProfileStore
        profile_id: Profile ID

    Returns:
        True if profile is expired
    """
    profile = store.profiles.get(profile_id)
    if not profile:
        return True

    if profile.type not in ("token", "oauth"):
        return False

    if not profile.expires or profile.expires <= 0:
        return False

    now = int(time.time() * 1000)
    return now >= profile.expires


def list_invalid_profiles(store: AuthProfileStore) -> list[str]:
    """List all invalid profile IDs.

    Args:
        store: AuthProfileStore

    Returns:
        List of invalid profile IDs
    """
    return [
        profile_id
        for profile_id in store.profiles
        if not check_profile_valid(store, profile_id)
    ]


def list_expired_profiles(store: AuthProfileStore) -> list[str]:
    """List all expired profile IDs.

    Args:
        store: AuthProfileStore

    Returns:
        List of expired profile IDs
    """
    return [
        profile_id
        for profile_id in store.profiles
        if check_profile_expired(store, profile_id)
    ]
