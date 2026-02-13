"""CLI banner formatting and display."""

import os
import re
import subprocess
import sys
from datetime import date

from openclaw_py.__version__ import __version__
from openclaw_py.cli.tagline import pick_tagline

# ASCII art lobster logo
LOBSTER_ASCII = [
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
    "██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██",
    "██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██",
    "██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██",
    "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    "                  🦞 OPENCLAW 🦞                    ",
    " ",
]

_banner_emitted = False


def _get_commit_hash() -> str | None:
    """Get git commit hash from environment or .git directory."""
    # Check environment first
    commit = os.environ.get("OPENCLAW_COMMIT_HASH")
    if commit:
        return commit.strip()

    # Try reading from git
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
            timeout=1,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass

    return None


def _visible_width(text: str) -> int:
    """Calculate visible width of text (excluding ANSI codes)."""
    ansi_escape = re.compile(r'\x1b\[[0-9;]*m')
    clean_text = ansi_escape.sub('', text)
    return len(clean_text)


def _has_json_flag(argv: list[str]) -> bool:
    """Check if --json flag is present."""
    return any(arg == "--json" or arg.startswith("--json=") for arg in argv)


def _has_version_flag(argv: list[str]) -> bool:
    """Check if --version or -v/-V flag is present."""
    return any(arg in ("--version", "-v", "-V") for arg in argv)


def format_cli_banner_line(
    version: str = __version__,
    commit: str | None = None,
    tagline: str | None = None,
    columns: int | None = None,
    rich: bool | None = None,
) -> str:
    """Format a single-line CLI banner.

    Args:
        version: Version string
        commit: Git commit hash
        tagline: Tagline text (auto-generated if None)
        columns: Terminal width (auto-detected if None)
        rich: Enable rich formatting (auto-detected if None)

    Returns:
        Formatted banner line
    """
    if commit is None:
        commit = _get_commit_hash()

    if tagline is None:
        tagline = pick_tagline()

    if columns is None:
        try:
            columns = os.get_terminal_size().columns
        except (AttributeError, OSError):
            columns = 120

    if rich is None:
        rich = sys.stdout.isatty()

    commit_label = commit or "unknown"
    title = "🦞 OpenClaw"
    prefix = "🦞 "

    plain_full_line = f"{title} {version} ({commit_label}) — {tagline}"
    fits_on_one_line = _visible_width(plain_full_line) <= columns

    if rich:
        try:
            from rich.text import Text

            # Rich formatting with colors
            if fits_on_one_line:
                text = Text()
                text.append(title, style="bold cyan")
                text.append(f" {version} ", style="blue")
                text.append(f"({commit_label})", style="dim")
                text.append(" — ", style="dim")
                text.append(tagline, style="cyan dim")
                return str(text)
            else:
                line1 = Text()
                line1.append(title, style="bold cyan")
                line1.append(f" {version} ", style="blue")
                line1.append(f"({commit_label})", style="dim")

                line2 = Text()
                line2.append(" " * len(prefix))
                line2.append(tagline, style="cyan dim")

                return f"{line1}\n{line2}"
        except ImportError:
            pass  # Fall back to plain text

    # Plain text fallback
    if fits_on_one_line:
        return plain_full_line

    line1 = f"{title} {version} ({commit_label})"
    line2 = f"{' ' * len(prefix)}{tagline}"
    return f"{line1}\n{line2}"


def format_cli_banner_art(rich: bool | None = None) -> str:
    """Format CLI banner ASCII art.

    Args:
        rich: Enable rich formatting (auto-detected if None)

    Returns:
        Formatted ASCII art
    """
    if rich is None:
        rich = sys.stdout.isatty()

    if not rich:
        return "\n".join(LOBSTER_ASCII)

    # Rich formatting (simplified - just return plain for now)
    # In a full implementation, you'd use Rich to color the ASCII art
    return "\n".join(LOBSTER_ASCII)


def emit_cli_banner(
    version: str = __version__,
    argv: list[str] | None = None,
    force: bool = False,
) -> None:
    """Emit CLI banner to stdout.

    Args:
        version: Version string
        argv: Command line arguments (defaults to sys.argv)
        force: Force emission even if already emitted
    """
    global _banner_emitted

    if _banner_emitted and not force:
        return

    if argv is None:
        argv = sys.argv

    # Don't emit banner if:
    # - Not a TTY
    # - --json flag present
    # - --version flag present
    if not sys.stdout.isatty():
        return

    if _has_json_flag(argv):
        return

    if _has_version_flag(argv):
        return

    line = format_cli_banner_line(version=version)
    print(f"\n{line}\n")

    _banner_emitted = True


def has_emitted_cli_banner() -> bool:
    """Check if banner has been emitted."""
    return _banner_emitted
