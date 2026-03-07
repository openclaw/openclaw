"""
SotyBot CLI

Command-line interface for managing agents and the engine.
"""

import asyncio
from typing import Optional
import json

import typer
from rich.console import Console
from rich.table import Table
from rich import print as rprint

from engine.agents.registry import registry


app = typer.Typer(
    name="sotybot",
    help="SotyBot - Open Agent Engine CLI",
    add_completion=False,
)

console = Console()


# ============================================================================
# Agent Commands
# ============================================================================

agent_app = typer.Typer(help="Manage agents")
app.add_typer(agent_app, name="agent")


@agent_app.command("list")
def list_agents() -> None:
    """List all available agents"""
    agents = registry.discover_agents()
    loaded = registry.list_loaded_agents()
    
    if not agents:
        console.print("[yellow]No agents found[/yellow]")
        return
    
    table = Table(title="Available Agents")
    table.add_column("Name", style="cyan")
    table.add_column("Domain", style="magenta")
    table.add_column("Description", style="white")
    table.add_column("Status", style="green")
    
    for agent_path in agents:
        try:
            metadata = registry.get_agent_metadata(agent_path)
            status = "✓ Loaded" if metadata.name in loaded else "○ Available"
            table.add_row(
                metadata.name,
                metadata.domain,
                metadata.description[:50] + "..." if len(metadata.description) > 50 else metadata.description,
                status,
            )
        except Exception as e:
            console.print(f"[red]Error loading metadata for {agent_path}: {e}[/red]")
    
    console.print(table)


@agent_app.command("load")
def load_agent(
    agent_path: str = typer.Argument(..., help="Agent path (e.g., creative/content_generator)"),
    config_file: Optional[str] = typer.Option(None, "--config", "-c", help="Config file (JSON)"),
) -> None:
    """Load an agent"""
    config = {}
    if config_file:
        with open(config_file, "r") as f:
            config = json.load(f)
    
    async def _load():
        try:
            agent = await registry.load_agent(agent_path, config)
            console.print(f"[green]✓ Loaded agent: {agent.name}[/green]")
            console.print(f"  Domain: {agent.domain}")
            console.print(f"  Risk Level: {agent.risk_level.value}")
            console.print(f"  Capabilities: {len(agent.get_capabilities())}")
        except Exception as e:
            console.print(f"[red]✗ Failed to load agent: {e}[/red]")
            raise typer.Exit(1)
    
    asyncio.run(_load())


@agent_app.command("unload")
def unload_agent(
    agent_name: str = typer.Argument(..., help="Agent name"),
) -> None:
    """Unload an agent"""
    async def _unload():
        try:
            await registry.unload_agent(agent_name)
            console.print(f"[green]✓ Unloaded agent: {agent_name}[/green]")
        except Exception as e:
            console.print(f"[red]✗ Failed to unload agent: {e}[/red]")
            raise typer.Exit(1)
    
    asyncio.run(_unload())


@agent_app.command("info")
def agent_info(
    agent_name: str = typer.Argument(..., help="Agent name"),
) -> None:
    """Get agent information"""
    try:
        info = registry.get_agent_info(agent_name)
        
        console.print(f"\n[bold cyan]{info.metadata.name}[/bold cyan]")
        console.print(f"Version: {info.metadata.version}")
        console.print(f"Author: {info.metadata.author}")
        console.print(f"Domain: {info.metadata.domain}")
        console.print(f"Risk Level: {info.metadata.risk_level.value}")
        console.print(f"Status: {info.status.value}")
        console.print(f"\nDescription:")
        console.print(f"  {info.metadata.description}")
        console.print(f"\nCapabilities:")
        for cap in info.metadata.capabilities:
            console.print(f"  • {cap}")
        console.print(f"\nStats:")
        console.print(f"  Executions: {info.execution_count}")
        console.print(f"  Errors: {info.error_count}")
        if info.last_execution:
            console.print(f"  Last Execution: {info.last_execution}")
        
    except Exception as e:
        console.print(f"[red]✗ Error: {e}[/red]")
        raise typer.Exit(1)


# ============================================================================
# Execute Command
# ============================================================================

@app.command("exec")
def execute(
    agent_name: str = typer.Argument(..., help="Agent name"),
    task: str = typer.Argument(..., help="Task to execute"),
    context_file: Optional[str] = typer.Option(None, "--context", "-c", help="Context file (JSON)"),
) -> None:
    """Execute a task on an agent"""
    context = {}
    if context_file:
        with open(context_file, "r") as f:
            context = json.load(f)
    
    async def _execute():
        try:
            console.print(f"[cyan]Executing task on {agent_name}...[/cyan]")
            result = await registry.execute_agent(agent_name, task, context)
            
            console.print(f"\n[green]✓ Task completed[/green]\n")
            console.print("[bold]Result:[/bold]")
            rprint(result)
            
        except Exception as e:
            console.print(f"[red]✗ Execution failed: {e}[/red]")
            raise typer.Exit(1)
    
    asyncio.run(_execute())


# ============================================================================
# Server Commands
# ============================================================================

@app.command("serve")
def serve(
    host: str = typer.Option("0.0.0.0", "--host", "-h", help="Host to bind to"),
    port: int = typer.Option(8000, "--port", "-p", help="Port to bind to"),
    reload: bool = typer.Option(False, "--reload", "-r", help="Enable auto-reload"),
) -> None:
    """Start the SotyBot engine server"""
    import uvicorn
    
    console.print(f"[cyan]Starting SotyBot engine on {host}:{port}...[/cyan]")
    
    uvicorn.run(
        "engine.core.app:app",
        host=host,
        port=port,
        reload=reload,
    )


@app.command("version")
def version() -> None:
    """Show SotyBot version"""
    console.print("[bold cyan]SotyBot[/bold cyan] v0.1.0")
    console.print("Open Agent Engine")


if __name__ == "__main__":
    app()
