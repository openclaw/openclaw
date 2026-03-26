#!/usr/bin/env python3
"""Art pipeline (HumbleForge) MCP server.

Tools: pipeline_status, pipeline_start, pipeline_stop
Manages GPU services on Kubuntu (100.93.214.109) via SSH.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.server.fastmcp import FastMCP
from _shared.ssh import ssh_exec
from _shared.fleet_config import get_node
from _shared.logging import emit_event

mcp = FastMCP("pipeline-tools")

KUBUNTU_NODE = "kubuntu"


@mcp.tool()
async def pipeline_status() -> str:
    """Get the status of the HumbleForge art pipeline services on Kubuntu.

    Reports GPU memory usage, running services, and queue depth.
    """
    node = get_node(KUBUNTU_NODE)
    if not node or not node.active:
        return json.dumps({"error": "Kubuntu node not available"})

    result = await ssh_exec(
        node.tailscale_ip,
        "echo '=== GPU ===' && nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo 'no GPU' && echo '=== SERVICES ===' && docker ps --filter 'name=humble' --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'no docker'",
        user=node.user,
        timeout=15,
    )

    emit_event("pipeline.status_check")
    return json.dumps({
        "node": node.name,
        "output": result.stdout,
        "error": result.stderr if result.returncode != 0 else None,
    }, indent=2)


@mcp.tool()
async def pipeline_start(service: str = "comfyui") -> str:
    """Start an art pipeline service on Kubuntu.

    Handles GPU lock contention — if another service holds the GPU,
    reports the conflict rather than force-starting.
    """
    node = get_node(KUBUNTU_NODE)
    if not node or not node.active:
        return json.dumps({"error": "Kubuntu node not available"})

    emit_event("pipeline.start", {"service": service})

    # Check for GPU contention first
    gpu_check = await ssh_exec(
        node.tailscale_ip,
        "nvidia-smi --query-compute-apps=pid,name,used_memory --format=csv,noheader 2>/dev/null",
        user=node.user,
        timeout=10,
    )

    if gpu_check.stdout.strip():
        return json.dumps({
            "warning": "GPU already in use",
            "current_processes": gpu_check.stdout,
            "action": f"Cannot start {service} while GPU is occupied. Stop the current process first.",
        }, indent=2)

    result = await ssh_exec(
        node.tailscale_ip,
        f"docker compose -f ~/humbleforge/docker-compose.yml up -d {service} 2>&1",
        user=node.user,
        timeout=30,
    )

    return json.dumps({
        "service": service,
        "success": result.returncode == 0,
        "output": result.stdout or result.stderr,
    }, indent=2)


@mcp.tool()
async def pipeline_stop(service: str = "comfyui") -> str:
    """Stop an art pipeline service on Kubuntu, releasing GPU VRAM."""
    node = get_node(KUBUNTU_NODE)
    if not node or not node.active:
        return json.dumps({"error": "Kubuntu node not available"})

    emit_event("pipeline.stop", {"service": service})

    result = await ssh_exec(
        node.tailscale_ip,
        f"docker compose -f ~/humbleforge/docker-compose.yml stop {service} 2>&1",
        user=node.user,
        timeout=30,
    )

    return json.dumps({
        "service": service,
        "success": result.returncode == 0,
        "output": result.stdout or result.stderr,
    }, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
