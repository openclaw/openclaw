#!/usr/bin/env python3
"""Fleet management MCP server.

Tools: fleet_status, node_status, node_exec, node_logs, node_restart, github_clone_repo
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Add parent for shared imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.server.fastmcp import FastMCP
from _shared.ssh import ssh_exec
from _shared.fleet_config import get_active_nodes, get_node
from _shared.logging import emit_event

mcp = FastMCP("fleet-tools")


@mcp.tool()
async def fleet_status() -> str:
    """Get status of all active fleet nodes. Returns connectivity, Docker containers, and resource usage."""
    nodes = get_active_nodes()
    results = {}

    for name, node in nodes.items():
        result = await ssh_exec(
            node.tailscale_ip,
            "hostname && uptime && docker ps --format '{{.Names}}: {{.Status}}' 2>/dev/null || echo 'docker not available'",
            user=node.user,
            timeout=15,
        )
        results[name] = {
            "node": node.name,
            "ip": node.tailscale_ip,
            "reachable": result.returncode == 0,
            "output": result.stdout if result.returncode == 0 else result.stderr,
        }

    emit_event("fleet.status_check", {"node_count": len(results)})
    return json.dumps(results, indent=2)


@mcp.tool()
async def node_status(node_name: str) -> str:
    """Get detailed status of a specific fleet node including Docker containers, disk, and memory."""
    node = get_node(node_name)
    if not node:
        return json.dumps({"error": f"Unknown node: {node_name}. Available: {', '.join(get_active_nodes().keys())}"})
    if not node.active:
        return json.dumps({"error": f"Node {node_name} is decommissioned"})

    result = await ssh_exec(
        node.tailscale_ip,
        "echo '=== HOSTNAME ===' && hostname && echo '=== UPTIME ===' && uptime && echo '=== MEMORY ===' && free -h && echo '=== DISK ===' && df -h / && echo '=== DOCKER ===' && docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'no docker'",
        user=node.user,
    )
    return json.dumps({
        "node": node.name,
        "ip": node.tailscale_ip,
        "returncode": result.returncode,
        "output": result.stdout,
        "error": result.stderr if result.returncode != 0 else None,
    }, indent=2)


@mcp.tool()
async def node_exec(node_name: str, command: str, timeout: int = 30) -> str:
    """Execute a shell command on a fleet node via SSH. Use with caution."""
    node = get_node(node_name)
    if not node or not node.active:
        return json.dumps({"error": f"Node {node_name} not available"})

    emit_event("fleet.node_exec", {"node": node_name, "command": command[:200]})

    result = await ssh_exec(node.tailscale_ip, command, user=node.user, timeout=min(timeout, 120))
    return json.dumps({
        "node": node.name,
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout[:8000],
        "stderr": result.stderr[:2000] if result.stderr else None,
    }, indent=2)


@mcp.tool()
async def node_logs(node_name: str, service: str = "openclaw-upstream", lines: int = 50) -> str:
    """Fetch Docker container logs from a fleet node."""
    node = get_node(node_name)
    if not node or not node.active:
        return json.dumps({"error": f"Node {node_name} not available"})

    result = await ssh_exec(
        node.tailscale_ip,
        f"docker logs --tail {min(lines, 200)} {service} 2>&1",
        user=node.user,
        timeout=15,
    )
    return json.dumps({
        "node": node.name,
        "service": service,
        "lines": result.stdout,
        "error": result.stderr if result.returncode != 0 else None,
    }, indent=2)


@mcp.tool()
async def node_restart(node_name: str, service: str = "openclaw-upstream") -> str:
    """Restart a Docker container on a fleet node."""
    node = get_node(node_name)
    if not node or not node.active:
        return json.dumps({"error": f"Node {node_name} not available"})

    emit_event("fleet.node_restart", {"node": node_name, "service": service})

    result = await ssh_exec(
        node.tailscale_ip,
        f"docker restart {service}",
        user=node.user,
        timeout=30,
    )
    return json.dumps({
        "node": node.name,
        "service": service,
        "success": result.returncode == 0,
        "output": result.stdout or result.stderr,
    }, indent=2)


@mcp.tool()
async def github_clone_repo(node_name: str, repo_url: str, target_dir: str) -> str:
    """Clone a GitHub repository to a fleet node via SSH."""
    node = get_node(node_name)
    if not node or not node.active:
        return json.dumps({"error": f"Node {node_name} not available"})

    result = await ssh_exec(
        node.tailscale_ip,
        f"git clone {repo_url} {target_dir} 2>&1",
        user=node.user,
        timeout=60,
    )
    return json.dumps({
        "node": node.name,
        "repo": repo_url,
        "target": target_dir,
        "success": result.returncode == 0,
        "output": result.stdout or result.stderr,
    }, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
