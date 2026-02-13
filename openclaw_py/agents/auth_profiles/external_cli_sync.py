"""Sync credentials from external CLI tools."""

import json
from pathlib import Path

from openclaw_py.logging import log_debug

from .constants import CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID
from .types import ApiKeyCredential, AuthProfileStore


def _get_anthropic_cli_config_path() -> Path | None:
    """Get Anthropic CLI config path.

    Returns:
        Path to config or None
    """
    home = Path.home()
    config_path = home / ".anthropic" / "config.json"
    return config_path if config_path.exists() else None


def _get_openai_cli_config_path() -> Path | None:
    """Get OpenAI CLI config path.

    Returns:
        Path to config or None
    """
    home = Path.home()
    config_path = home / ".openai" / "config.json"
    return config_path if config_path.exists() else None


def _sync_anthropic_cli_credentials(store: AuthProfileStore) -> bool:
    """Sync Anthropic CLI credentials.

    Args:
        store: AuthProfileStore

    Returns:
        True if credentials were synced
    """
    config_path = _get_anthropic_cli_config_path()
    if not config_path:
        return False

    try:
        content = config_path.read_text(encoding="utf-8")
        config = json.loads(content)

        api_key = config.get("api_key")
        if not api_key or not isinstance(api_key, str):
            return False

        # Check if profile already exists with same key
        existing = store.profiles.get(CLAUDE_CLI_PROFILE_ID)
        if existing and existing.type == "api_key" and existing.key == api_key:
            return False

        # Add/update profile
        store.profiles[CLAUDE_CLI_PROFILE_ID] = ApiKeyCredential(
            type="api_key",
            provider="anthropic",
            key=api_key,
        )

        log_debug(f"synced Anthropic CLI credentials: {CLAUDE_CLI_PROFILE_ID}")
        return True

    except Exception:
        return False


def _sync_openai_cli_credentials(store: AuthProfileStore) -> bool:
    """Sync OpenAI CLI credentials.

    Args:
        store: AuthProfileStore

    Returns:
        True if credentials were synced
    """
    config_path = _get_openai_cli_config_path()
    if not config_path:
        return False

    try:
        content = config_path.read_text(encoding="utf-8")
        config = json.loads(content)

        api_key = config.get("api_key")
        if not api_key or not isinstance(api_key, str):
            return False

        # Check if profile already exists with same key
        existing = store.profiles.get(CODEX_CLI_PROFILE_ID)
        if existing and existing.type == "api_key" and existing.key == api_key:
            return False

        # Add/update profile
        store.profiles[CODEX_CLI_PROFILE_ID] = ApiKeyCredential(
            type="api_key",
            provider="openai",
            key=api_key,
        )

        log_debug(f"synced OpenAI CLI credentials: {CODEX_CLI_PROFILE_ID}")
        return True

    except Exception:
        return False


def sync_external_cli_credentials(store: AuthProfileStore) -> bool:
    """Sync credentials from external CLI tools.

    Attempts to sync from:
    - Anthropic CLI (~/.anthropic/config.json)
    - OpenAI CLI (~/.openai/config.json)

    Args:
        store: AuthProfileStore to update

    Returns:
        True if any credentials were synced
    """
    synced_anthropic = _sync_anthropic_cli_credentials(store)
    synced_openai = _sync_openai_cli_credentials(store)

    return synced_anthropic or synced_openai
