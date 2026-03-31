"""
bodhi_vault.vault_ingest — Feed vault nodes into a running LightRAG server.

Usage (called by OpenClaw cron or manually):
    python -m bodhi_vault.vault_ingest [--vault PATH] [--lightrag-url URL]

Defaults:
    vault:        ~/.openclaw/vault/
    lightrag-url: http://localhost:8765

Incremental: only sends nodes modified since last run.
Last-run timestamp written to ~/.openclaw/lightrag_last_ingest.txt
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any


VAULT_DEFAULT = Path(os.path.expanduser("~/.openclaw/vault"))
LIGHTRAG_DEFAULT = "http://localhost:8765"
LAST_RUN_FILE = Path(os.path.expanduser("~/.openclaw/lightrag_last_ingest.txt"))


def collect_nodes(vault_path: Path) -> list[dict[str, Any]]:
    """Return all vault node dicts from vault_path/nodes/**/*.json."""
    nodes_dir = vault_path / "nodes"
    if not nodes_dir.exists():
        return []
    nodes = []
    for f in sorted(nodes_dir.rglob("*.json")):
        try:
            nodes.append(json.loads(f.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            continue
    return nodes


def node_to_text(node: dict[str, Any]) -> str:
    """Convert vault node to LightRAG document string."""
    body = node.get("content_enriched") or node.get("content", "")
    return f"[domain:{node.get('domain','unknown')}] [id:{node.get('id','?')}]\n{body}"


def _last_run() -> float:
    try:
        return float(LAST_RUN_FILE.read_text().strip()) if LAST_RUN_FILE.exists() else 0.0
    except ValueError:
        return 0.0


def _save_run(ts: float) -> None:
    LAST_RUN_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = LAST_RUN_FILE.with_suffix(".tmp")
    tmp.write_text(str(ts))
    tmp.replace(LAST_RUN_FILE)


def _is_new(node: dict, since: float) -> bool:
    ts_str = node.get("updated_at") or node.get("created_at", "")
    try:
        from datetime import datetime, timezone
        return datetime.fromisoformat(ts_str).timestamp() > since
    except (ValueError, TypeError):
        return True


def ingest(vault_path: Path = VAULT_DEFAULT, lightrag_url: str = LIGHTRAG_DEFAULT) -> int:
    """Ingest new vault nodes into LightRAG. Returns count ingested."""
    import httpx

    since = _last_run()
    nodes = [n for n in collect_nodes(vault_path) if _is_new(n, since)]
    if not nodes:
        return 0

    documents = [node_to_text(n) for n in nodes]
    # Endpoint varies by LightRAG version — verify after install:
    # curl http://localhost:8765/openapi.json | python3 -m json.tool | grep path
    # Common paths: /documents  OR  /documents/text
    resp = httpx.post(f"{lightrag_url}/documents/text", json={"documents": documents}, timeout=120)
    resp.raise_for_status()
    _save_run(time.time())
    return len(nodes)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Ingest vault nodes into LightRAG")
    parser.add_argument("--vault", type=Path, default=VAULT_DEFAULT)
    parser.add_argument("--lightrag-url", default=LIGHTRAG_DEFAULT)
    args = parser.parse_args()
    count = ingest(args.vault, args.lightrag_url)
    if count:
        print(f"LightRAG: {count} nodes ingested")
