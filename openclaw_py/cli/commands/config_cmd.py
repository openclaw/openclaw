"""Config command - configuration management."""

import typer

from openclaw_py.cli.utils import error_exit, info, print_json
from openclaw_py.config.loader import load_config_sync as load_config
from openclaw_py.config.paths import resolve_config_path

config_app = typer.Typer(name="config", help="Manage configuration")


@config_app.command(name="show")
def show_cmd(
    json: bool = typer.Option(False, "--json", help="Output as JSON"),
) -> None:
    """Show current configuration."""
    try:
        config = load_config()
        config_path = resolve_config_path()

        if json:
            # Output as JSON
            print_json(config.model_dump(mode="json", exclude_none=True))
        else:
            # Human-readable output
            info(f"Configuration file: {config_path}")
            info("\nConfiguration summary:")
            info(f"  Agents: {len(config.agents.list) if config.agents and config.agents.list else 0}")
            info(f"  Telegram: {'Enabled' if config.telegram and config.telegram.token else 'Disabled'}")
            info(f"  Gateway HTTP: {config.gateway.http.port if config.gateway and config.gateway.http else 'Not set'}")
            info(f"  Gateway WS: {config.gateway.ws.port if config.gateway and config.gateway.ws else 'Not set'}")

    except Exception as e:
        error_exit(f"Failed to load configuration: {e}")


@config_app.command(name="path")
def path_cmd() -> None:
    """Show configuration file path."""
    config_path = resolve_config_path()
    print(config_path)


@config_app.command(name="edit")
def edit_cmd() -> None:
    """Open configuration file in editor."""
    import os
    import subprocess

    config_path = resolve_config_path()

    if not config_path.exists():
        error_exit(f"Configuration file not found: {config_path}. Run 'openclaw setup' first.")

    # Try to open in editor
    editor = os.environ.get("EDITOR", "notepad" if os.name == "nt" else "vi")

    try:
        subprocess.run([editor, str(config_path)], check=True)
    except Exception as e:
        error_exit(f"Failed to open editor: {e}")
