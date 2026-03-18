"""
bodhi_vault.enrich — Enrichment for vault nodes.

Phase 0 (now): Pure-Python concept matching against hard-coded reference library.
    - match_concepts(): keyword scan against concepts.json
    - enrich_node_concepts(): writes related_papers to node, idempotent

Phase 1 (Core container online): Ollama integration.
    - expand_content(): calls gemma3:12b at localhost:11434
    - enrich_node(): full async enrichment (concepts + expanded content)

The two phases are kept separate. Phase 0 works offline, no GPU needed.
Phase 1 is wired in once the Ubuntu machine is running Ollama.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Phase 0: Pure-Python concept matching
# ---------------------------------------------------------------------------

def match_concepts(text: str, concepts_path: Path) -> list[dict[str, Any]]:
    """
    Match text against the hard-coded research reference library.

    Keyword-based: checks if any of a concept's `related` keywords appear
    in the text (case-insensitive). Returns matched concepts without duplicates.

    Args:
        text: The node's content (or content_enriched if available).
        concepts_path: Path to data/concepts.json.

    Returns:
        List of matched concept dicts with keys: id, label, url, scholar.
    """
    concepts = _load_concepts(concepts_path)
    text_lower = text.lower()
    matched: list[dict[str, Any]] = []
    seen: set[str] = set()

    for concept in concepts:
        if concept["id"] in seen:
            continue
        for keyword in concept.get("related", []):
            if keyword.lower() in text_lower:
                matched.append({
                    "id": concept["id"],
                    "label": concept["label"],
                    "url": concept.get("url", ""),
                    "scholar": concept.get("scholar", ""),
                })
                seen.add(concept["id"])
                break  # One keyword match is enough per concept

    return matched


def enrich_node_concepts(
    node_id: str,
    vault_path: Path,
    schema_path: Path,
    concepts_path: Path,
    force: bool = False,
) -> bool:
    """
    Match concepts for a node and write related_papers to it. Idempotent.

    Returns True if enrichment was applied, False if already enriched or
    node not found. Pass force=True to re-enrich even if already enriched.
    """
    from bodhi_vault.read import get_node

    node = get_node(vault_path, node_id)
    if node is None:
        return False

    # Idempotent: skip if already has related_papers (unless forced)
    if not force and node.get("related_papers") is not None:
        return False

    text = node.get("content_enriched") or node.get("content", "")
    matched = match_concepts(text, concepts_path)

    node["related_papers"] = matched if matched else []
    node["updated_at"] = datetime.now(timezone.utc).isoformat()

    _write_node_inplace(node, vault_path)
    return True


# ---------------------------------------------------------------------------
# Phase 1: Ollama integration (gemma3:12b, replaces NotImplementedError stub)
# ---------------------------------------------------------------------------

async def expand_content(
    content: str,
    model: str = "gemma3:12b",
    ollama_host: str = "http://127.0.0.1:11434",
) -> str:
    """
    Expand a fragmented thought using a local Ollama model.

    Replaces the NotImplementedError stub. Uses gemma3:12b by default
    (upgraded from mistral-nemo:12b). Fully offline — never calls Anthropic.
    """
    import httpx

    prompt = (
        "Expand this fragmented thought into 2-3 legible sentences. "
        "Preserve the original meaning exactly. Do not add opinions.\n\n"
        f"{content}"
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{ollama_host}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False},
        )
        resp.raise_for_status()
        return resp.json()["response"].strip()


async def enrich_node(
    node_id: str,
    vault_path: Path,
    schema_path: Path,
    concepts_path: Path,
    model: str = "gemma3:12b",
    ollama_host: str = "http://127.0.0.1:11434",
) -> bool:
    """
    Full enrichment: expand content with Ollama + match concepts. Idempotent.
    """
    from bodhi_vault.read import get_node

    node = get_node(vault_path, node_id)
    if node is None:
        return False
    if node.get("content_enriched"):
        return False  # Already enriched

    content_enriched = await expand_content(node["content"], model, ollama_host)
    node["content_enriched"] = content_enriched
    node["enrichment_model"] = model
    node["enriched_at"] = datetime.now(timezone.utc).isoformat()

    text = node.get("content", "")
    node["related_papers"] = match_concepts(text, concepts_path)
    node["updated_at"] = datetime.now(timezone.utc).isoformat()

    _write_node_inplace(node, vault_path)
    return True


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_concepts(concepts_path: Path) -> list[dict[str, Any]]:
    with open(concepts_path, encoding="utf-8") as f:
        return json.load(f)["concepts"]


def _write_node_inplace(node: dict[str, Any], vault_path: Path) -> None:
    """Atomically overwrite a node file in-place. Does not re-validate schema."""
    year_month = node["created_at"][:7]
    node_dir = vault_path / "nodes" / year_month
    node_file = node_dir / f"{node['id']}.json"

    tmp_fd, tmp_path_str = tempfile.mkstemp(dir=node_dir, suffix=".tmp")
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(node, indent=2, ensure_ascii=False))
        os.replace(tmp_path, node_file)
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise
