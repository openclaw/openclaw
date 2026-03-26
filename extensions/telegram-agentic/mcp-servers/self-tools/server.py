#!/usr/bin/env python3
"""Self-introspection MCP server.

Tools: source_read, self_edit
Allows the agent to read and edit its own plugin source code on a branch.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.server.fastmcp import FastMCP
from _shared.logging import emit_event

mcp = FastMCP("self-tools")

# The plugin source root — set via env or default to the extension directory
PLUGIN_SOURCE_ROOT = Path(
    os.environ.get(
        "PLUGIN_SOURCE_ROOT",
        str(Path(__file__).resolve().parent.parent.parent),
    )
)


@mcp.tool()
async def source_read(path: str) -> str:
    """Read a source file from the telegram-agentic plugin.

    Path is relative to the plugin root (extensions/telegram-agentic/).
    """
    target = (PLUGIN_SOURCE_ROOT / path).resolve()

    # Security: ensure the path stays within the plugin root
    if not str(target).startswith(str(PLUGIN_SOURCE_ROOT)):
        return json.dumps({"error": "Path escapes plugin root"})

    if not target.exists():
        return json.dumps({"error": f"File not found: {path}"})

    if not target.is_file():
        return json.dumps({"error": f"Not a file: {path}"})

    try:
        content = target.read_text(encoding="utf-8")
        emit_event("self.source_read", {"path": path, "size": len(content)})
        return json.dumps({
            "path": path,
            "content": content[:50000],
            "truncated": len(content) > 50000,
        }, indent=2)
    except OSError as e:
        return json.dumps({"error": f"Read failed: {e}"})


@mcp.tool()
async def self_edit(path: str, content: str, create_branch: bool = True) -> str:
    """Edit a source file in the telegram-agentic plugin.

    By default creates a new git branch for the edit. Path is relative
    to the plugin root (extensions/telegram-agentic/).
    """
    target = (PLUGIN_SOURCE_ROOT / path).resolve()

    if not str(target).startswith(str(PLUGIN_SOURCE_ROOT)):
        return json.dumps({"error": "Path escapes plugin root"})

    emit_event("self.source_edit", {"path": path, "size": len(content)})

    try:
        if create_branch:
            import subprocess

            branch_name = f"self-edit/{path.replace('/', '-').replace('.', '-')}"
            # Check if we're in a git repo
            git_root = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=str(PLUGIN_SOURCE_ROOT),
                capture_output=True, text=True,
            )
            if git_root.returncode == 0:
                subprocess.run(
                    ["git", "checkout", "-b", branch_name],
                    cwd=git_root.stdout.strip(),
                    capture_output=True, text=True,
                )

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

        return json.dumps({
            "path": path,
            "written": len(content),
            "branch": branch_name if create_branch else None,
        }, indent=2)
    except OSError as e:
        return json.dumps({"error": f"Write failed: {e}"})


if __name__ == "__main__":
    mcp.run(transport="stdio")
