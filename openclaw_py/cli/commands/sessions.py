"""Sessions command - list and manage sessions."""

import typer

from openclaw_py.cli.utils import error_exit, info, print_json
from openclaw_py.config.loader import load_config_sync as load_config
# from openclaw_py.sessions.store import create_session_store  # TODO: Implement in batch 15


def sessions_cmd(
    json: bool = typer.Option(False, "--json", help="Output as JSON"),
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum number of sessions to show"),
) -> None:
    """List active sessions."""
    try:
        config = load_config()

        # TODO: Implement session listing in batch 15
        if json:
            print_json({"total": 0, "shown": 0, "sessions": []})
        else:
            info("No active sessions found.")
            info("\n💡 Session listing will be implemented in batch 15")

    except Exception as e:
        error_exit(f"Failed to list sessions: {e}")
