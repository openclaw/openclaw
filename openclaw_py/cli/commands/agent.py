"""Agent command - run and manage a single agent."""

import asyncio

import typer

from openclaw_py.cli.utils import error_exit, info, success
from openclaw_py.config.loader import load_config_sync as load_config

agent_app = typer.Typer(name="agent", help="Run and manage agents")


@agent_app.command(name="run")
def run_cmd(
    agent_id: str = typer.Option("main", "--agent", "-a", help="Agent ID to run"),
    interactive: bool = typer.Option(False, "--interactive", "-i", help="Run in interactive mode"),
) -> None:
    """Run an agent interactively."""
    try:
        config = load_config()

        # Find agent
        agent_config = None
        if config.agents and config.agents.list:
            for agent in config.agents.list:
                if agent.id == agent_id:
                    agent_config = agent
                    break

        if not agent_config:
            error_exit(f"Agent '{agent_id}' not found in configuration")

        info(f"Starting agent: {agent_config.name or agent_config.id}")

        if interactive:
            info("\nInteractive mode - type your messages below (Ctrl+C to exit)")
            info("=" * 60)

            # Simple interactive loop
            while True:
                try:
                    user_input = input("\nYou: ")
                    if not user_input.strip():
                        continue

                    # TODO: Actually call the agent runtime
                    info("Agent: [Not implemented - agent runtime integration needed]")

                except KeyboardInterrupt:
                    info("\n\nExiting interactive mode.")
                    break
        else:
            info("Non-interactive agent run not yet implemented.")
            info("Use --interactive flag for interactive mode.")

    except Exception as e:
        error_exit(f"Failed to run agent: {e}")


@agent_app.command(name="test")
def test_cmd(
    agent_id: str = typer.Option("main", "--agent", "-a", help="Agent ID to test"),
) -> None:
    """Test agent configuration."""
    try:
        config = load_config()

        # Find agent
        agent_config = None
        if config.agents and config.agents.list:
            for agent in config.agents.list:
                if agent.id == agent_id:
                    agent_config = agent
                    break

        if not agent_config:
            error_exit(f"Agent '{agent_id}' not found in configuration")

        success(f"Agent configuration: {agent_config.name or agent_config.id}")
        info(f"  ID: {agent_config.id}")
        info(f"  Name: {agent_config.name or '(not set)'}")
        info(f"  Default: {agent_config.default or False}")
        info(f"  Model: {agent_config.model or '(default)'}")

    except Exception as e:
        error_exit(f"Failed to test agent: {e}")
