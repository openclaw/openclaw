"""Status command - show system status."""

import typer

from openclaw_py.cli.utils import error_exit, info, print_json, success
from openclaw_py.config.loader import load_config_sync as load_config


def status_cmd(
    json: bool = typer.Option(False, "--json", help="Output as JSON"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
) -> None:
    """Show OpenClaw system status."""
    try:
        config = load_config()

        # Build status summary
        status = {
            "ok": True,
            "agents": [],
            "channels": {},
            "gateway": {
                "http": {"port": config.gateway.http.port if config.gateway and config.gateway.http else None},
                "ws": {"port": config.gateway.ws.port if config.gateway and config.gateway.ws else None},
            },
        }

        # Get agent list
        if config.agents and config.agents.list:
            for agent in config.agents.list:
                status["agents"].append({
                    "id": agent.id,
                    "name": agent.name or agent.id,
                    "default": agent.default or False,
                })

        # Get channel status
        if config.telegram and config.telegram.token:
            status["channels"]["telegram"] = {
                "configured": True,
                "enabled": True,
            }

        if json:
            print_json(status)
        else:
            success("OpenClaw Status")
            info("=" * 40)
            info(f"\nAgents: {len(status['agents'])}")
            for agent in status["agents"]:
                marker = " (default)" if agent["default"] else ""
                info(f"  • {agent['id']}{marker}")

            info(f"\nChannels:")
            if status["channels"]:
                for channel, details in status["channels"].items():
                    info(f"  • {channel}: {'Configured' if details.get('configured') else 'Not configured'}")
            else:
                info("  (none configured)")

            info(f"\nGateway:")
            info(f"  • HTTP port: {status['gateway']['http']['port']}")
            info(f"  • WebSocket port: {status['gateway']['ws']['port']}")

    except Exception as e:
        error_exit(f"Failed to get status: {e}")
