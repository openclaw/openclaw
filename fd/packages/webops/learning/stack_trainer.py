"""Stack Trainer — deterministic "learning" phase for OpenClaw.

On boot (or periodic refresh), reads config files and repo docs to build
a structured Stack Map:  what sites exist, where they're hosted, what
domains map where, what tracking should be present, what webhooks are expected.

v1 is purely deterministic (no embeddings/ML).  It reads sites.yaml +
tool_access.yaml + optional docs dir and produces stack_state + stack_findings.

This is NOT ML training — it's structured ingestion that gives OpenClaw
context about the business's tech stack.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from packages.common.logging import get_logger
from packages.webops.registry import load_sites, load_tool_access

log = get_logger("webops.learning.stack_trainer")


def build_stack_map(
    *,
    sites_path: str = "config/sites.yaml",
    tool_access_path: str = "config/tool_access.yaml",
    docs_dir: str | None = None,
) -> dict[str, Any]:
    """Build a deterministic Stack Map from config files.

    Returns a structured dict describing:
    - sites: per-site hosting, DNS, tracking, webhooks
    - tools: available tool access + capabilities
    - docs_scanned: count of doc files ingested (if docs_dir provided)
    - capabilities: what OpenClaw can do with current config
    """
    sites = load_sites(sites_path)
    tools = load_tool_access(tool_access_path)

    # Build capabilities graph from tool access
    capabilities: list[str] = []
    for tool_name, tool_cfg in tools.items():
        allowed = tool_cfg.get("allowed", [])
        if "read" in allowed:
            capabilities.append(f"{tool_name}:read")
        if "write" in allowed:
            capabilities.append(f"{tool_name}:write")

    # Scan docs directory if provided
    docs_scanned = 0
    doc_summaries: list[dict[str, str]] = []
    if docs_dir:
        docs_path = Path(docs_dir)
        if docs_path.is_dir():
            for f in sorted(docs_path.rglob("*.md")):
                docs_scanned += 1
                doc_summaries.append({
                    "path": str(f.relative_to(docs_path)),
                    "size_bytes": str(f.stat().st_size),
                })

    # Build per-site summary
    site_summaries: list[dict[str, Any]] = []
    for site in sites:
        summary: dict[str, Any] = {
            "site_key": site.get("site_key"),
            "brand": site.get("brand"),
            "env": site.get("env"),
            "dns_provider": site.get("provider", {}).get("dns"),
            "hosting_provider": site.get("provider", {}).get("hosting"),
            "has_tracking": bool(site.get("tracking")),
            "has_stripe_webhooks": bool(site.get("stripe", {}).get("webhook_endpoints_expected")),
        }
        site_summaries.append(summary)

    stack_map = {
        "version": "1.0",
        "generated_at": datetime.now(tz=UTC).isoformat(),
        "sites": site_summaries,
        "tools": {
            name: {
                "auth_method": cfg.get("auth"),
                "allowed": cfg.get("allowed", []),
                "rpm": cfg.get("rate_limit", {}).get("rpm", 0),
            }
            for name, cfg in tools.items()
        },
        "capabilities": sorted(capabilities),
        "docs_scanned": docs_scanned,
        "doc_summaries": doc_summaries[:50],  # bounded
    }

    log.info("stack_map_built", extra={
        "sites": len(site_summaries),
        "tools": len(tools),
        "capabilities": len(capabilities),
        "docs_scanned": docs_scanned,
    })

    return stack_map


def save_stack_state(
    stack_map: dict[str, Any],
    output_path: str = "data/stack_state.json",
) -> str:
    """Write stack map to JSON file. Returns the output path."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(stack_map, indent=2, default=str))
    log.info("stack_state_saved", extra={"path": output_path})
    return output_path


def run_stack_trainer(
    *,
    sites_path: str = "config/sites.yaml",
    tool_access_path: str = "config/tool_access.yaml",
    docs_dir: str | None = None,
    output_path: str = "data/stack_state.json",
) -> dict[str, Any]:
    """Full training pass: build stack map and save to disk.

    Returns the stack map dict.
    """
    stack_map = build_stack_map(
        sites_path=sites_path,
        tool_access_path=tool_access_path,
        docs_dir=docs_dir,
    )
    save_stack_state(stack_map, output_path=output_path)
    return stack_map
