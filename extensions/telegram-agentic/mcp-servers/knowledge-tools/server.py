#!/usr/bin/env python3
"""Knowledge API MCP server.

Tools: knowledge_search, knowledge_entity
Connects to the Knowledge API running on Pop!_OS (100.119.126.67:8890).
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
from _shared.logging import emit_event

mcp = FastMCP("knowledge-tools")

KNOWLEDGE_API_BASE = os.environ.get("KNOWLEDGE_API_URL", "http://100.119.126.67:8890")


def _api_call(path: str, method: str = "GET", body: dict | None = None) -> dict:
    """Make an HTTP call to the Knowledge API."""
    url = f"{KNOWLEDGE_API_BASE}{path}"
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    data = json.dumps(body).encode() if body else None

    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except URLError as e:
        return {"error": f"Knowledge API unreachable: {e}"}
    except json.JSONDecodeError:
        return {"error": "Invalid JSON response from Knowledge API"}


@mcp.tool()
async def knowledge_search(query: str, limit: int = 10) -> str:
    """Search the knowledge base using semantic search. Returns relevant documents, notes, and entities."""
    emit_event("knowledge.search", {"query": query[:200]})

    result = _api_call(f"/search?q={query}&limit={min(limit, 50)}")
    return json.dumps(result, indent=2)


@mcp.tool()
async def knowledge_entity(entity_name: str) -> str:
    """Look up a specific entity in the knowledge base. Returns all known facts, relationships, and source documents."""
    emit_event("knowledge.entity_lookup", {"entity": entity_name})

    result = _api_call(f"/entities/{entity_name}")
    return json.dumps(result, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
