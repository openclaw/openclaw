"""Typer CLI application builder."""

import typer
from rich.console import Console

from openclaw_py.__version__ import CLI_NAME, __version__
from openclaw_py.cli.banner import emit_cli_banner

console = Console()


def version_callback(value: bool) -> None:
    """Print version and exit."""
    if value:
        print(f"{CLI_NAME} {__version__}")
        raise typer.Exit()


def create_app() -> typer.Typer:
    """Create and configure the Typer CLI application.

    Returns:
        Configured Typer application
    """
    app = typer.Typer(
        name=CLI_NAME,
        help="OpenClaw - Multi-channel AI gateway with extensible messaging integrations",
        add_completion=True,
        rich_markup_mode="rich",
        no_args_is_help=True,
    )

    # Add version option
    app.callback(invoke_without_command=True)(
        lambda version: version,
    )

    @app.callback()
    def main_callback(
        ctx: typer.Context,
        version: bool = typer.Option(
            False,
            "--version",
            "-v",
            "-V",
            help="Show version and exit",
            callback=version_callback,
            is_eager=True,
        ),
    ) -> None:
        """OpenClaw CLI - Your AI assistant gateway."""
        # Emit banner for interactive commands (not for --version or --json)
        if ctx.invoked_subcommand and not version:
            emit_cli_banner()

    # Import and register commands
    from openclaw_py.cli.commands.agent import agent_app
    from openclaw_py.cli.commands.agents import agents_app
    from openclaw_py.cli.commands.config_cmd import config_app
    from openclaw_py.cli.commands.configure import configure_cmd
    from openclaw_py.cli.commands.gateway import gateway_app
    from openclaw_py.cli.commands.health import health_cmd
    from openclaw_py.cli.commands.memory import memory_app
    from openclaw_py.cli.commands.sessions import sessions_cmd
    from openclaw_py.cli.commands.setup import setup_cmd
    from openclaw_py.cli.commands.status import status_cmd
    from openclaw_py.cli.commands.telegram import telegram_app

    # Register subcommands
    app.command(name="setup", help="Run initial setup wizard")(setup_cmd)
    app.command(name="configure", help="Interactive configuration wizard")(configure_cmd)
    app.command(name="status", help="Show system status")(status_cmd)
    app.command(name="health", help="Run health checks")(health_cmd)
    app.command(name="sessions", help="List active sessions")(sessions_cmd)

    # Register sub-apps
    app.add_typer(config_app, name="config", help="Manage configuration")
    app.add_typer(agent_app, name="agent", help="Run and manage agents")
    app.add_typer(agents_app, name="agents", help="List and configure agents")
    app.add_typer(gateway_app, name="gateway", help="Manage Gateway server")
    app.add_typer(telegram_app, name="telegram", help="Manage Telegram bot")
    app.add_typer(memory_app, name="memory", help="Manage session memory")

    return app
