"""Auth profile file path resolution."""

from pathlib import Path

from openclaw_py.config.paths import resolve_state_dir
from openclaw_py.utils.common import ensure_dir

from .constants import AUTH_PROFILE_FILENAME, LEGACY_AUTH_FILENAME


def resolve_auth_store_path(agent_dir: str | None = None) -> Path:
    """Resolve auth-profiles.json path.

    Args:
        agent_dir: Optional agent directory (for subagents)

    Returns:
        Path to auth-profiles.json

    Examples:
        >>> resolve_auth_store_path()
        Path('~/.openclaw/auth-profiles.json')
        >>> resolve_auth_store_path("agent1")
        Path('~/.openclaw/agents/agent1/auth-profiles.json')
    """
    state_dir = resolve_state_dir()

    if not agent_dir:
        return state_dir / AUTH_PROFILE_FILENAME

    agents_dir = state_dir / "agents" / agent_dir
    return agents_dir / AUTH_PROFILE_FILENAME


def resolve_legacy_auth_store_path(agent_dir: str | None = None) -> Path:
    """Resolve legacy auth.json path.

    Args:
        agent_dir: Optional agent directory

    Returns:
        Path to legacy auth.json
    """
    state_dir = resolve_state_dir()

    if not agent_dir:
        return state_dir / LEGACY_AUTH_FILENAME

    agents_dir = state_dir / "agents" / agent_dir
    return agents_dir / LEGACY_AUTH_FILENAME


def ensure_auth_store_file(auth_path: Path) -> None:
    """Ensure auth store file and parent directories exist.

    Args:
        auth_path: Path to auth store file
    """
    ensure_dir(str(auth_path.parent))

    if not auth_path.exists():
        auth_path.write_text("{}", encoding="utf-8")
