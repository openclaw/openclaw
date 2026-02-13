"""CLI utility functions."""

import json
import sys
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

console = Console()


def print_json(data: Any, pretty: bool = True) -> None:
    """Print data as JSON.

    Args:
        data: Data to print
        pretty: Pretty-print with indentation
    """
    if pretty:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(data, ensure_ascii=False))


def print_table(
    data: list[dict[str, Any]],
    headers: list[str] | None = None,
    title: str | None = None,
) -> None:
    """Print data as a Rich table.

    Args:
        data: List of dictionaries to print
        headers: Column headers (auto-detected if None)
        title: Table title
    """
    if not data:
        console.print("[dim]No data to display[/dim]")
        return

    # Auto-detect headers from first row
    if headers is None:
        headers = list(data[0].keys())

    table = Table(title=title, show_header=True, header_style="bold cyan")

    for header in headers:
        table.add_column(header)

    for row in data:
        table.add_row(*[str(row.get(h, "")) for h in headers])

    console.print(table)


def error_exit(message: str, code: int = 1) -> None:
    """Print error message and exit.

    Args:
        message: Error message
        code: Exit code
    """
    console.print(f"[bold red]Error:[/bold red] {message}", file=sys.stderr)
    raise typer.Exit(code)


def success(message: str) -> None:
    """Print success message.

    Args:
        message: Success message
    """
    console.print(f"[bold green]✓[/bold green] {message}")


def info(message: str) -> None:
    """Print info message.

    Args:
        message: Info message
    """
    console.print(f"[blue]ℹ[/blue] {message}")


def warn(message: str) -> None:
    """Print warning message.

    Args:
        message: Warning message
    """
    console.print(f"[bold yellow]⚠[/bold yellow] {message}")


def confirm(message: str, default: bool = False) -> bool:
    """Prompt user for confirmation.

    Args:
        message: Confirmation message
        default: Default value if user just presses Enter

    Returns:
        True if user confirmed
    """
    return typer.confirm(message, default=default)


def prompt(message: str, default: str | None = None, password: bool = False) -> str:
    """Prompt user for input.

    Args:
        message: Prompt message
        default: Default value
        password: Hide input (for passwords)

    Returns:
        User input
    """
    return typer.prompt(message, default=default, hide_input=password)
