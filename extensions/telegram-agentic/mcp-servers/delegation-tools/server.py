#!/usr/bin/env python3
"""Task delegation MCP server.

Tools: delegate_task, claude_code_run, gemini_deep_research, notebooklm_research
Handles background task creation via Archon and synchronous Claude Code execution.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.server.fastmcp import FastMCP
from _shared.ssh import ssh_exec
from _shared.fleet_config import get_node
from _shared.logging import emit_event

mcp = FastMCP("delegation-tools")

ARCHON_API_BASE = os.environ.get("ARCHON_API_URL", "http://100.69.32.10:8181")


def _archon_call(path: str, method: str = "GET", body: dict | None = None) -> dict:
    """Make an HTTP call to the Archon API."""
    url = f"{ARCHON_API_BASE}{path}"
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    data = json.dumps(body).encode() if body else None

    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except (URLError, json.JSONDecodeError) as e:
        return {"error": f"Archon API call failed: {e}"}


@mcp.tool()
async def delegate_task(
    title: str,
    description: str,
    target_node: str = "mac",
    working_dir: str = "~/Dev_Projects",
    priority: str = "medium",
) -> str:
    """Create a background task in Archon for a fleet worker to execute.

    The task is picked up by a distributed worker on the target node,
    which spawns Claude Code CLI in a git worktree. Returns immediately
    with the task ID. Use Archon MCP tools to check status.
    """
    emit_event("delegation.task_create", {
        "title": title[:100],
        "target_node": target_node,
        "priority": priority,
    })

    result = _archon_call("/api/tasks", method="POST", body={
        "title": title,
        "description": description,
        "status": "todo",
        "metadata": {
            "source": "delegate_task",
            "target_node": target_node,
            "working_dir": working_dir,
            "priority": priority,
        },
    })

    return json.dumps(result, indent=2)


@mcp.tool()
async def claude_code_run(
    prompt: str,
    target_node: str = "mac",
    working_dir: str = "~/Dev_Projects",
    timeout: int = 120,
) -> str:
    """Run Claude Code CLI synchronously on a fleet node and return the output.

    This is the "quick task" variant — blocks until completion.
    For longer tasks, use delegate_task instead.
    """
    node = get_node(target_node)
    if not node or not node.active:
        return json.dumps({"error": f"Node {target_node} not available"})

    emit_event("delegation.claude_code_run", {
        "target_node": target_node,
        "prompt_length": len(prompt),
    })

    # Escape the prompt for shell
    escaped_prompt = prompt.replace("'", "'\\''")
    command = f"cd {working_dir} && claude -p '{escaped_prompt}' --output-format text 2>&1"

    result = await ssh_exec(
        node.tailscale_ip,
        command,
        user=node.user,
        timeout=min(timeout, 300),
    )

    return json.dumps({
        "node": node.name,
        "success": result.returncode == 0,
        "output": result.stdout[:10000],
        "error": result.stderr[:2000] if result.returncode != 0 else None,
    }, indent=2)


@mcp.tool()
async def gemini_deep_research(query: str, timeout: int = 600) -> str:
    """Run a deep research query using Gemini on the Mac via browser automation.

    This is slow (up to 10 minutes). Returns research results as text.
    """
    node = get_node("mac")
    if not node or not node.active:
        return json.dumps({"error": "Mac node not available for browser automation"})

    emit_event("delegation.gemini_research", {"query": query[:200]})

    # Delegate to a script that handles browser automation
    escaped = query.replace("'", "'\\''")
    result = await ssh_exec(
        node.tailscale_ip,
        f"python3 ~/Dev_Projects/openclaw_mattbermanmods/shared/gemini_research.py '{escaped}'",
        user=node.user,
        timeout=min(timeout, 660),
    )

    return json.dumps({
        "query": query,
        "success": result.returncode == 0,
        "result": result.stdout[:15000],
        "error": result.stderr[:2000] if result.returncode != 0 else None,
    }, indent=2)


@mcp.tool()
async def notebooklm_research(query: str, timeout: int = 600) -> str:
    """Run a research query using NotebookLM on the Mac via browser automation.

    This is slow (up to 10 minutes). Returns research results as text.
    """
    node = get_node("mac")
    if not node or not node.active:
        return json.dumps({"error": "Mac node not available for browser automation"})

    emit_event("delegation.notebooklm_research", {"query": query[:200]})

    escaped = query.replace("'", "'\\''")
    result = await ssh_exec(
        node.tailscale_ip,
        f"python3 ~/Dev_Projects/openclaw_mattbermanmods/shared/notebooklm_research.py '{escaped}'",
        user=node.user,
        timeout=min(timeout, 660),
    )

    return json.dumps({
        "query": query,
        "success": result.returncode == 0,
        "result": result.stdout[:15000],
        "error": result.stderr[:2000] if result.returncode != 0 else None,
    }, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
