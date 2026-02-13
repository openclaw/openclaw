"""Agents command - list and configure agents."""

import typer

from openclaw_py.cli.utils import error_exit, info, print_json, print_table
from openclaw_py.config.loader import load_config_sync as load_config

agents_app = typer.Typer(name="agents", help="List and configure agents")


@agents_app.command(name="list")
def list_cmd(
    json: bool = typer.Option(False, "--json", help="Output as JSON"),
    bindings: bool = typer.Option(False, "--bindings", help="Show routing bindings"),
) -> None:
    """List all configured agents."""
    try:
        config = load_config()

        if not config.agents or not config.agents.list:
            info("No agents configured.")
            return

        agents_data = []
        for agent in config.agents.list:
            agents_data.append({
                "id": agent.id,
                "name": agent.name or agent.id,
                "default": agent.default or False,
                "model": str(agent.model) if agent.model else "(default)",
            })

        if json:
            # JSON output
            output = {
                "agents": agents_data,
                "total": len(agents_data),
            }

            if bindings and config.bindings:
                output["bindings"] = [
                    {
                        "agent_id": binding.agent_id,
                        "match": binding.match.model_dump(mode="json") if binding.match else None,
                    }
                    for binding in config.bindings
                ]

            print_json(output)
        else:
            # Table output
            print_table(
                [
                    {
                        "ID": a["id"],
                        "Name": a["name"],
                        "Default": "Yes" if a["default"] else "No",
                        "Model": a["model"],
                    }
                    for a in agents_data
                ],
                title=f"Agents ({len(agents_data)})",
            )

            if bindings and config.bindings:
                info("\nRouting Bindings:")
                for binding in config.bindings:
                    info(f"  • Agent '{binding.agent_id}' -> {binding.match}")

    except Exception as e:
        error_exit(f"Failed to list agents: {e}")


@agents_app.command(name="default")
def default_cmd() -> None:
    """Show the default agent."""
    try:
        config = load_config()

        if not config.agents or not config.agents.list:
            error_exit("No agents configured.")

        # Find default agent
        default_agent = None
        for agent in config.agents.list:
            if agent.default:
                default_agent = agent
                break

        if not default_agent and config.agents.list:
            # No explicit default, use first agent
            default_agent = config.agents.list[0]

        if default_agent:
            info(f"Default agent: {default_agent.id}")
            info(f"  Name: {default_agent.name or '(not set)'}")
            info(f"  Model: {default_agent.model or '(default)'}")
        else:
            error_exit("No default agent found.")

    except Exception as e:
        error_exit(f"Failed to get default agent: {e}")
