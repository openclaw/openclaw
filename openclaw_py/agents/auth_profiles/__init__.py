"""Auth profiles management for AI provider credentials.

This module handles multiple authentication profiles per provider,
with round-robin rotation, cooldown tracking, and external CLI sync.
"""

from .constants import (
    AUTH_PROFILE_FILENAME,
    AUTH_STORE_VERSION,
    CLAUDE_CLI_PROFILE_ID,
    CODEX_CLI_PROFILE_ID,
    LEGACY_AUTH_FILENAME,
)
from .order import resolve_auth_profile_order
from .profiles import (
    list_profiles_for_provider,
    mark_auth_profile_good,
    set_auth_profile_order,
    upsert_auth_profile,
)
from .store import (
    ensure_auth_profile_store,
    load_auth_profile_store,
    save_auth_profile_store,
    update_auth_profile_store_with_lock,
)
from .types import (
    ApiKeyCredential,
    AuthProfileCredential,
    AuthProfileFailureReason,
    AuthProfileStore,
    OAuthCredential,
    ProfileUsageStats,
    TokenCredential,
)
from .usage import (
    clear_auth_profile_cooldown,
    is_profile_in_cooldown,
    mark_auth_profile_cooldown,
    mark_auth_profile_failure,
    mark_auth_profile_used,
)

__all__ = [
    # Types
    "ApiKeyCredential",
    "TokenCredential",
    "OAuthCredential",
    "AuthProfileCredential",
    "AuthProfileFailureReason",
    "ProfileUsageStats",
    "AuthProfileStore",
    # Constants
    "AUTH_STORE_VERSION",
    "AUTH_PROFILE_FILENAME",
    "LEGACY_AUTH_FILENAME",
    "CLAUDE_CLI_PROFILE_ID",
    "CODEX_CLI_PROFILE_ID",
    # Store
    "load_auth_profile_store",
    "ensure_auth_profile_store",
    "save_auth_profile_store",
    "update_auth_profile_store_with_lock",
    # Profiles
    "upsert_auth_profile",
    "list_profiles_for_provider",
    "mark_auth_profile_good",
    "set_auth_profile_order",
    # Order
    "resolve_auth_profile_order",
    # Usage
    "mark_auth_profile_used",
    "mark_auth_profile_failure",
    "mark_auth_profile_cooldown",
    "clear_auth_profile_cooldown",
    "is_profile_in_cooldown",
]
