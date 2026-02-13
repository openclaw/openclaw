"""OAuth token refresh (simplified implementation)."""

import time

from openclaw_py.logging import log_debug, log_warn

from .types import AuthProfileStore, OAuthCredential


def is_oauth_token_near_expiry(
    credential: OAuthCredential,
    near_expiry_ms: int = 10 * 60 * 1000,
) -> bool:
    """Check if OAuth token is near expiry.

    Args:
        credential: OAuth credential
        near_expiry_ms: Near expiry threshold in ms (default 10 minutes)

    Returns:
        True if token is near expiry or expired
    """
    if not credential.expires:
        return False

    now = int(time.time() * 1000)
    return now + near_expiry_ms >= credential.expires


def should_refresh_oauth_token(credential: OAuthCredential) -> bool:
    """Check if OAuth token should be refreshed.

    Args:
        credential: OAuth credential

    Returns:
        True if token should be refreshed
    """
    if not credential.refresh:
        return False

    return is_oauth_token_near_expiry(credential)


async def refresh_oauth_token(
    store: AuthProfileStore,
    profile_id: str,
    agent_dir: str | None = None,
) -> bool:
    """Refresh OAuth token for a profile.

    Note: This is a simplified implementation. Full OAuth refresh requires
    provider-specific implementations (anthropic, openai, etc).

    Args:
        store: AuthProfileStore
        profile_id: Profile ID
        agent_dir: Optional agent directory

    Returns:
        True if refresh succeeded
    """
    profile = store.profiles.get(profile_id)
    if not profile or profile.type != "oauth":
        return False

    oauth_cred = profile

    if not should_refresh_oauth_token(oauth_cred):
        log_debug(f"OAuth token not near expiry: {profile_id}")
        return True

    if not oauth_cred.refresh:
        log_warn(f"OAuth profile has no refresh token: {profile_id}")
        return False

    # TODO: Implement provider-specific OAuth refresh
    # For now, just log a warning
    log_warn(f"OAuth token refresh not yet implemented: {profile_id}")
    return False
