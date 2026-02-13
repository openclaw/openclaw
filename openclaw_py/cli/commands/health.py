"""Health command - run health checks."""

import typer

from openclaw_py.cli.utils import error_exit, info, print_json, success, warn
from openclaw_py.config.loader import load_config_sync as load_config
from openclaw_py.config.paths import resolve_config_path


def health_cmd(
    json: bool = typer.Option(False, "--json", help="Output as JSON"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
) -> None:
    """Run health checks on OpenClaw installation."""
    checks = []

    # Check 1: Configuration file exists
    config_path = resolve_config_path()
    config_check = {
        "name": "Configuration file",
        "status": "ok" if config_path.exists() else "error",
        "message": str(config_path) if config_path.exists() else f"Not found: {config_path}",
    }
    checks.append(config_check)

    # Check 2: Load configuration
    config_load_check = {"name": "Configuration load", "status": "unknown", "message": ""}
    try:
        config = load_config()
        config_load_check["status"] = "ok"
        config_load_check["message"] = "Successfully loaded"
    except Exception as e:
        config_load_check["status"] = "error"
        config_load_check["message"] = str(e)
    checks.append(config_load_check)

    # Check 3: Agent configuration
    agent_check = {"name": "Agent configuration", "status": "unknown", "message": ""}
    try:
        config = load_config()
        if config.agents and config.agents.list:
            agent_check["status"] = "ok"
            agent_check["message"] = f"{len(config.agents.list)} agent(s) configured"
        else:
            agent_check["status"] = "warn"
            agent_check["message"] = "No agents configured"
    except Exception as e:
        agent_check["status"] = "error"
        agent_check["message"] = str(e)
    checks.append(agent_check)

    # Check 4: Channel configuration
    channel_check = {"name": "Channel configuration", "status": "unknown", "message": ""}
    try:
        config = load_config()
        channels = []
        if config.telegram and config.telegram.token:
            channels.append("telegram")

        if channels:
            channel_check["status"] = "ok"
            channel_check["message"] = f"{len(channels)} channel(s): {', '.join(channels)}"
        else:
            channel_check["status"] = "warn"
            channel_check["message"] = "No channels configured"
    except Exception as e:
        channel_check["status"] = "error"
        channel_check["message"] = str(e)
    checks.append(channel_check)

    # Check 5: API keys
    api_key_check = {"name": "API keys", "status": "unknown", "message": ""}
    try:
        config = load_config()
        providers = []
        if config.models:
            if config.models.anthropic and config.models.anthropic.api_key:
                providers.append("Anthropic")
            if config.models.openai and config.models.openai.api_key:
                providers.append("OpenAI")

        if providers:
            api_key_check["status"] = "ok"
            api_key_check["message"] = f"Configured: {', '.join(providers)}"
        else:
            api_key_check["status"] = "warn"
            api_key_check["message"] = "No API keys configured"
    except Exception as e:
        api_key_check["status"] = "error"
        api_key_check["message"] = str(e)
    checks.append(api_key_check)

    # Summary
    error_count = sum(1 for c in checks if c["status"] == "error")
    warn_count = sum(1 for c in checks if c["status"] == "warn")
    ok_count = sum(1 for c in checks if c["status"] == "ok")

    health_summary = {
        "ok": error_count == 0,
        "checks": checks,
        "summary": {
            "total": len(checks),
            "ok": ok_count,
            "warn": warn_count,
            "error": error_count,
        },
    }

    if json:
        print_json(health_summary)
    else:
        info("OpenClaw Health Check")
        info("=" * 40)
        info("")

        for check in checks:
            status_icon = "✓" if check["status"] == "ok" else "⚠" if check["status"] == "warn" else "✗"
            status_color = "green" if check["status"] == "ok" else "yellow" if check["status"] == "warn" else "red"

            if check["status"] == "ok":
                success(f"{status_icon} {check['name']}: {check['message']}")
            elif check["status"] == "warn":
                warn(f"{status_icon} {check['name']}: {check['message']}")
            else:
                info(f"[bold {status_color}]{status_icon}[/bold {status_color}] {check['name']}: {check['message']}")

        info("")
        info(f"Summary: {ok_count} OK, {warn_count} warnings, {error_count} errors")

        if error_count > 0:
            raise typer.Exit(1)
