"""Configure command - interactive configuration wizard."""

import typer

from openclaw_py.cli.utils import error_exit, info, success
from openclaw_py.config.loader import load_config_sync as load_config
from openclaw_py.config.paths import resolve_config_path


def configure_cmd() -> None:
    """Interactive configuration wizard.

    Opens an interactive wizard to configure OpenClaw settings.
    """
    info("OpenClaw Configuration Wizard")
    info("=" * 40)

    try:
        config = load_config()
        config_path = resolve_config_path()

        info(f"\nCurrent configuration loaded from: {config_path}")
        info(f"Agents configured: {len(config.agents.list) if config.agents and config.agents.list else 0}")
        info(f"Telegram enabled: {'Yes' if config.telegram and config.telegram.token else 'No'}")
        info(f"Gateway HTTP port: {config.gateway.http.port if config.gateway and config.gateway.http else '(not set)'}")

        info("\n💡 To modify settings, edit the config file directly:")
        info(f"   {config_path}")
        info("\n💡 For initial setup, run:")
        info("   openclaw setup")

    except Exception as e:
        error_exit(f"Failed to load configuration: {e}")
