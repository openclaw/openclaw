#!/usr/bin/env python3
"""Library management MCP server.

Tools: library_sync, library_catalog, library_search, library_detail,
       library_read, library_stats, library_deploy_skill
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# Add parent for shared imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.server.fastmcp import FastMCP
from _shared.logging import emit_event

mcp = FastMCP("library-tools")

# --- Config ---

LIBRARY_DIR = Path(os.environ.get("OPENCLAW_LIBRARY_DIR", "/opt/openclaw-library"))
LIBRARY_REPO = os.environ.get(
    "OPENCLAW_LIBRARY_REPO", "https://github.com/snowdroog/openclaw-library.git"
)


# --- YAML loading (inline to avoid pyyaml dependency at import time) ---


def _load_yaml(path: Path) -> dict | list:
    """Load a YAML file. Returns empty dict on failure."""
    try:
        import yaml

        with open(path) as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


# --- Git helpers ---


def _git_run(args: list[str], cwd: str | None = None, timeout: int = 30) -> dict:
    """Run a git command and return {stdout, stderr, returncode}."""
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=cwd or str(LIBRARY_DIR),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"Git command timed out after {timeout}s", "returncode": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "returncode": -1}


# --- Catalog loading ---


def _get_l0l1(info: dict) -> tuple[str, str]:
    """Extract L0/L1 from a catalog entry (handles case variations)."""
    l0 = str(info.get("l0", info.get("L0", ""))).strip()
    l1 = str(info.get("l1", info.get("L1", ""))).strip()
    return l0, l1


def _load_skill_catalog() -> list[dict]:
    """Load skills from skill-abstracts.yaml."""
    data = _load_yaml(LIBRARY_DIR / "skills" / "skill-abstracts.yaml")
    if isinstance(data, dict):
        items = []
        for key, info in data.items():
            if not isinstance(info, dict):
                continue
            l0, l1 = _get_l0l1(info)
            parts = str(key).split("/", 1)
            collection = parts[0] if len(parts) > 1 else "default"
            skill_id = parts[-1]
            items.append({
                "id": str(key),
                "skill_id": skill_id,
                "collection": collection,
                "l0": l0,
                "l1": l1,
                "path": f"skills/{collection}/{skill_id}/",
            })
        return items
    return []


def _load_agent_catalog() -> list[dict]:
    """Load agents from agent-abstracts.yaml."""
    data = _load_yaml(LIBRARY_DIR / "agents" / "agent-abstracts.yaml")
    if isinstance(data, dict):
        items = []
        for key, info in data.items():
            if not isinstance(info, dict):
                continue
            l0, l1 = _get_l0l1(info)
            items.append({
                "id": str(key),
                "l0": l0,
                "l1": l1,
                "path": f"agents/{key}.md",
            })
        return items
    return []


def _load_prompt_catalog() -> list[dict]:
    """Load prompts from prompt-abstracts.yaml."""
    data = _load_yaml(LIBRARY_DIR / "prompts" / "prompt-abstracts.yaml")
    if isinstance(data, dict):
        items = []
        for category, entries in data.items():
            if not isinstance(entries, dict):
                continue
            for key, info in entries.items():
                if not isinstance(info, dict):
                    continue
                l0, l1 = _get_l0l1(info)
                items.append({
                    "id": str(key),
                    "category": str(category),
                    "l0": l0,
                    "l1": l1,
                })
        return items
    return []


def _load_sfa_catalog() -> list[dict]:
    """Load single-file agents from sfa-abstracts.yaml."""
    data = _load_yaml(LIBRARY_DIR / "single-file-agents" / "sfa-abstracts.yaml")
    if isinstance(data, dict):
        items = []
        for key, info in data.items():
            if not isinstance(info, dict):
                continue
            l0, l1 = _get_l0l1(info)
            items.append({
                "id": str(key),
                "l0": l0,
                "l1": l1,
                "path": f"single-file-agents/{key}",
            })
        return items
    return []


# --- MCP Tools ---


@mcp.tool()
async def library_sync() -> str:
    """Pull the latest library from git. Clones if not present."""
    if not LIBRARY_DIR.exists():
        result = _git_run(
            ["clone", "--depth", "1", LIBRARY_REPO, str(LIBRARY_DIR)],
            cwd="/tmp",
            timeout=60,
        )
        action = "cloned"
    else:
        result = _git_run(["pull", "--ff-only"], timeout=30)
        action = "pulled"

    if result["returncode"] != 0:
        return json.dumps({"success": False, "error": result["stderr"]})

    # Get commit info
    log = _git_run(["log", "-1", "--format=%H %s"])
    commit = log["stdout"] if log["returncode"] == 0 else "unknown"

    stats = {
        "skills": len(_load_skill_catalog()),
        "agents": len(_load_agent_catalog()),
        "prompts": len(_load_prompt_catalog()),
        "sfas": len(_load_sfa_catalog()),
    }

    emit_event("library.sync", {"action": action, "commit": commit[:40]})
    return json.dumps({"success": True, "action": action, "commit": commit, "stats": stats}, indent=2)


@mcp.tool()
async def library_catalog(artifact_type: str = "all") -> str:
    """List all library artifacts with L0 abstracts. Type: all, skills, agents, prompts, sfas."""
    result = {}

    if artifact_type in ("all", "skills"):
        result["skills"] = _load_skill_catalog()
    if artifact_type in ("all", "agents"):
        result["agents"] = _load_agent_catalog()
    if artifact_type in ("all", "prompts"):
        result["prompts"] = _load_prompt_catalog()
    if artifact_type in ("all", "sfas"):
        result["sfas"] = _load_sfa_catalog()

    return json.dumps(result, indent=2)


@mcp.tool()
async def library_search(query: str, top_k: int = 10) -> str:
    """Keyword search across all library catalogs (L0 + L1 + id matching)."""
    query_lower = query.lower()
    scored: list[tuple[int, str, dict]] = []

    for catalog_type, items in [
        ("skill", _load_skill_catalog()),
        ("agent", _load_agent_catalog()),
        ("prompt", _load_prompt_catalog()),
        ("sfa", _load_sfa_catalog()),
    ]:
        for item in items:
            item_id = item.get("id", "").lower()
            l0 = item.get("l0", "").lower()
            l1 = item.get("l1", "").lower()

            relevance = 0
            if query_lower == item_id or query_lower in item_id:
                relevance = 3
            elif query_lower in l0:
                relevance = 2
            elif query_lower in l1:
                relevance = 1

            if relevance > 0:
                scored.append((relevance, catalog_type, {**item, "type": catalog_type, "relevance": relevance}))

    scored.sort(key=lambda x: -x[0])
    results = [entry for _, _, entry in scored[:top_k]]

    emit_event("library.search", {"query": query, "results": len(results)})
    return json.dumps(results, indent=2)


@mcp.tool()
async def library_detail(artifact_id: str) -> str:
    """Load L1 detail for a specific artifact."""
    # Search with top_k=1
    results = json.loads(await library_search(artifact_id, top_k=1))
    if not results:
        return json.dumps({"error": f"Artifact not found: {artifact_id}"})
    return json.dumps(results[0], indent=2)


@mcp.tool()
async def library_read(artifact_id: str) -> str:
    """Load full L2 content (SKILL.md, agent .md, etc.) for an artifact."""
    # Find the artifact
    results = json.loads(await library_search(artifact_id, top_k=1))
    if not results:
        return json.dumps({"error": f"Artifact not found: {artifact_id}"})

    item = results[0]
    path = item.get("path")
    if not path:
        return json.dumps({"error": f"No path for artifact: {artifact_id}"})

    # Try SKILL.md first (for skills), then the path directly
    candidates = [
        LIBRARY_DIR / path / "SKILL.md",
        LIBRARY_DIR / f"{path}.md" if not path.endswith(".md") else LIBRARY_DIR / path,
        LIBRARY_DIR / path,
    ]

    for candidate in candidates:
        if candidate.is_file():
            try:
                content = candidate.read_text(encoding="utf-8")
                return json.dumps({
                    "id": item.get("id"),
                    "type": item.get("type"),
                    "path": str(candidate.relative_to(LIBRARY_DIR)),
                    "content": content,
                }, indent=2)
            except Exception as e:
                return json.dumps({"error": f"Failed to read {candidate}: {e}"})

    return json.dumps({"error": f"Content file not found for: {artifact_id}", "tried": [str(c) for c in candidates]})


@mcp.tool()
async def library_stats() -> str:
    """Library health and sync status."""
    exists = LIBRARY_DIR.exists()

    if not exists:
        return json.dumps({"library_dir": str(LIBRARY_DIR), "exists": False})

    log = _git_run(["log", "-1", "--format=%H %s (%cr)"])
    last_commit = log["stdout"] if log["returncode"] == 0 else "unknown"

    return json.dumps({
        "library_dir": str(LIBRARY_DIR),
        "exists": True,
        "last_commit": last_commit,
        "counts": {
            "skills": len(_load_skill_catalog()),
            "agents": len(_load_agent_catalog()),
            "prompts": len(_load_prompt_catalog()),
            "sfas": len(_load_sfa_catalog()),
        },
    }, indent=2)


@mcp.tool()
async def library_deploy_skill(skill_id: str, node: str = "local") -> str:
    """Deploy a skill from the library to a node's ~/.openclaw/skills/ directory.

    This bridges the library with upstream OpenClaw's native skill loader.
    The skill becomes immediately available if skills.load.watch is enabled.
    """
    # Find the skill
    results = json.loads(await library_search(skill_id, top_k=1))
    if not results or results[0].get("type") != "skill":
        return json.dumps({"error": f"Skill not found: {skill_id}"})

    item = results[0]
    skill_path = LIBRARY_DIR / item["path"] / "SKILL.md"
    if not skill_path.is_file():
        skill_path = LIBRARY_DIR / item["path"]
        if not skill_path.is_file():
            return json.dumps({"error": f"SKILL.md not found at {item['path']}"})

    content = skill_path.read_text(encoding="utf-8")
    target_id = item.get("skill_id", item["id"].split("/")[-1])

    if node == "local":
        # Deploy locally
        target_dir = Path.home() / ".openclaw" / "skills" / target_id
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "SKILL.md").write_text(content, encoding="utf-8")
        deployed_to = str(target_dir)
    else:
        # Deploy to remote node via SSH
        from _shared.fleet_config import get_node
        from _shared.ssh import ssh_exec

        import asyncio

        fleet_node = get_node(node)
        if not fleet_node or not fleet_node.active:
            return json.dumps({"error": f"Node not available: {node}"})

        target_path = f"~/.openclaw/skills/{target_id}"
        result = await ssh_exec(
            fleet_node.tailscale_ip,
            f"mkdir -p '{target_path}' && cat > '{target_path}/SKILL.md'",
            user=fleet_node.user,
            timeout=15,
        )
        if result.returncode != 0:
            return json.dumps({"error": f"SSH deploy failed: {result.stderr}"})
        deployed_to = f"{fleet_node.user}@{fleet_node.tailscale_ip}:{target_path}"

    emit_event("library.deploy_skill", {"skill_id": skill_id, "node": node, "target": deployed_to})
    return json.dumps({
        "success": True,
        "skill_id": target_id,
        "deployed_to": deployed_to,
        "content_length": len(content),
    }, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
