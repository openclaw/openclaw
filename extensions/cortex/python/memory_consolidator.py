#!/usr/bin/env python3
"""
Memory Consolidation Engine for Helios Cortex.

Clusters semantically similar STM entries using embeddings + cosine similarity,
then calls Ollama to synthesize consolidated insights from each cluster.

Workflow:
  1. Load all STM entries with embeddings
  2. Cluster by cosine similarity (threshold 0.85)
  3. For clusters of 3+ entries, call Ollama phi3:mini to synthesize
  4. Store consolidated memory at higher importance
  5. Archive originals (add consolidated_from JSON array to the new entry)

Usage:
    python3 memory_consolidator.py [--threshold 0.85] [--min-cluster 3] [--dry-run]
"""
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_DEFAULT_DATA_DIR = Path.home() / ".openclaw" / "workspace" / "memory"
DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", _DEFAULT_DATA_DIR))
DB_PATH = DATA_DIR / "brain.db"
EMBEDDINGS_URL = os.environ.get("EMBEDDINGS_URL", "http://localhost:8030")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "phi3:mini")

DEFAULT_SIMILARITY_THRESHOLD = 0.85
DEFAULT_MIN_CLUSTER_SIZE = 3

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _blob_to_vec(blob: Optional[bytes]) -> Optional[np.ndarray]:
    if blob is None:
        return None
    return np.frombuffer(blob, dtype=np.float32)


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _embed_text(text: str) -> Optional[np.ndarray]:
    """Get embedding vector from GPU daemon."""
    try:
        resp = requests.post(
            f"{EMBEDDINGS_URL}/embed",
            json={"text": text},
            timeout=5,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        vec = data.get("embeddings", [None])[0] or data.get("embedding")
        if vec is None:
            return None
        return np.array(vec, dtype=np.float32)
    except Exception:
        return None


def _ollama_synthesize(entries: List[str], model: str = OLLAMA_MODEL,
                       ollama_url: str = OLLAMA_URL) -> Optional[str]:
    """Call Ollama to synthesize a consolidated insight from multiple entries."""
    numbered = "\n".join(f"{i+1}. {e[:500]}" for i, e in enumerate(entries))
    prompt = (
        "You are a memory consolidation engine. Below are several related memory entries "
        "that overlap in content. Synthesize them into ONE concise, information-dense "
        "consolidated entry. Preserve all unique facts, dates, and specifics. "
        "Remove redundancy. Output ONLY the consolidated text, no preamble.\n\n"
        f"Entries:\n{numbered}\n\nConsolidated:"
    )
    try:
        resp = requests.post(
            f"{ollama_url}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False},
            timeout=120,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        return data.get("response", "").strip()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Core Consolidation
# ---------------------------------------------------------------------------


def load_stm_with_embeddings(db_path: str = str(DB_PATH)) -> List[dict]:
    """Load STM entries that have embeddings."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("""
        SELECT s.id, s.content, s.categories, s.importance, s.created_at,
               s.access_count, e.embedding
        FROM stm s
        JOIN embeddings e ON e.source_type = 'stm' AND e.source_id = s.id
        ORDER BY s.created_at DESC
    """)
    rows = []
    for r in c.fetchall():
        vec = _blob_to_vec(r["embedding"])
        if vec is not None:
            rows.append({
                "id": r["id"],
                "content": r["content"],
                "categories": r["categories"],
                "importance": r["importance"],
                "created_at": r["created_at"],
                "access_count": r["access_count"],
                "embedding": vec,
            })
    conn.close()
    return rows


def cluster_entries(
    entries: List[dict],
    threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
) -> List[List[dict]]:
    """Cluster entries by cosine similarity using greedy single-linkage.

    Returns list of clusters (each cluster is a list of entry dicts).
    Each entry appears in at most one cluster.
    """
    n = len(entries)
    assigned = [False] * n
    clusters: List[List[dict]] = []

    for i in range(n):
        if assigned[i]:
            continue
        cluster = [entries[i]]
        assigned[i] = True
        for j in range(i + 1, n):
            if assigned[j]:
                continue
            # Check similarity against ALL existing cluster members (complete linkage)
            if all(
                _cosine(entries[j]["embedding"], member["embedding"]) >= threshold
                for member in cluster
            ):
                cluster.append(entries[j])
                assigned[j] = True
        clusters.append(cluster)

    return clusters


def consolidate(
    db_path: str = str(DB_PATH),
    threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    min_cluster_size: int = DEFAULT_MIN_CLUSTER_SIZE,
    dry_run: bool = False,
    ollama_url: str = OLLAMA_URL,
    ollama_model: str = OLLAMA_MODEL,
) -> dict:
    """Run the full consolidation pipeline.

    Returns:
        {
            "clusters_found": int,
            "entries_consolidated": int,
            "new_memories": int,
            "clusters": [{"size": int, "ids": [...], "consolidated_id": str|None}]
        }
    """
    entries = load_stm_with_embeddings(db_path)
    clusters = cluster_entries(entries, threshold=threshold)

    # Filter to clusters >= min_cluster_size
    big_clusters = [c for c in clusters if len(c) >= min_cluster_size]

    result = {
        "clusters_found": len(big_clusters),
        "entries_consolidated": 0,
        "new_memories": 0,
        "clusters": [],
    }

    if dry_run or not big_clusters:
        for cl in big_clusters:
            result["clusters"].append({
                "size": len(cl),
                "ids": [e["id"] for e in cl],
                "consolidated_id": None,
            })
            result["entries_consolidated"] += len(cl)
        return result

    # Import brain for write operations
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from brain import UnifiedBrain
    brain = UnifiedBrain(db_path)

    for cl in big_clusters:
        contents = [e["content"] for e in cl]
        ids = [e["id"] for e in cl]

        # Synthesize via Ollama
        synthesis = _ollama_synthesize(contents, model=ollama_model,
                                       ollama_url=ollama_url)
        if not synthesis:
            # Fallback: just concatenate unique content
            synthesis = " | ".join(set(contents))

        # Compute new importance: max of cluster + 0.5 bump, capped at 3.0
        max_imp = max(e["importance"] for e in cl)
        new_importance = min(max_imp + 0.5, 3.0)

        # Merge categories from all entries
        all_cats: set = set()
        for e in cl:
            try:
                cats = json.loads(e["categories"]) if isinstance(e["categories"], str) else e["categories"]
                if isinstance(cats, list):
                    all_cats.update(cats)
            except (json.JSONDecodeError, TypeError):
                pass
        merged_cats = sorted(all_cats) or ["consolidated"]

        # Store consolidated memory with source tracking
        consolidated_meta = json.dumps({
            "consolidated_from": ids,
            "cluster_size": len(cl),
            "consolidated_at": datetime.now().isoformat(),
        })

        new_id = brain.remember(
            content=synthesis,
            categories=merged_cats,
            importance=new_importance,
            source="consolidation",
        )

        # Update the new STM entry to include consolidated_from in metadata
        conn = sqlite3.connect(db_path)
        conn.execute(
            "UPDATE stm SET source = ? WHERE id = ?",
            (f"consolidation:{consolidated_meta}", new_id),
        )
        conn.commit()
        conn.close()

        result["clusters"].append({
            "size": len(cl),
            "ids": ids,
            "consolidated_id": new_id,
        })
        result["entries_consolidated"] += len(cl)
        result["new_memories"] += 1

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Helios Memory Consolidation Engine")
    parser.add_argument("--threshold", type=float, default=DEFAULT_SIMILARITY_THRESHOLD,
                        help=f"Cosine similarity threshold (default: {DEFAULT_SIMILARITY_THRESHOLD})")
    parser.add_argument("--min-cluster", type=int, default=DEFAULT_MIN_CLUSTER_SIZE,
                        help=f"Minimum cluster size (default: {DEFAULT_MIN_CLUSTER_SIZE})")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be consolidated without writing")
    parser.add_argument("--db", default=str(DB_PATH), help="brain.db path")
    parser.add_argument("--ollama-url", default=OLLAMA_URL, help="Ollama API URL")
    parser.add_argument("--ollama-model", default=OLLAMA_MODEL, help="Ollama model")

    args = parser.parse_args()

    print(f"🧠 Memory Consolidation Engine")
    print(f"   DB: {args.db}")
    print(f"   Threshold: {args.threshold}")
    print(f"   Min cluster: {args.min_cluster}")
    print(f"   Dry run: {args.dry_run}")
    print()

    result = consolidate(
        db_path=args.db,
        threshold=args.threshold,
        min_cluster_size=args.min_cluster,
        dry_run=args.dry_run,
        ollama_url=args.ollama_url,
        ollama_model=args.ollama_model,
    )

    print(f"Clusters found: {result['clusters_found']}")
    print(f"Entries consolidated: {result['entries_consolidated']}")
    print(f"New memories created: {result['new_memories']}")
    print()

    for i, cl in enumerate(result["clusters"]):
        status = "✅" if cl.get("consolidated_id") else "📋 (dry-run)" if args.dry_run else "❌"
        print(f"  {status} Cluster {i+1}: {cl['size']} entries → {cl.get('consolidated_id', 'N/A')}")
        for eid in cl["ids"][:5]:
            print(f"      - {eid}")
        if len(cl["ids"]) > 5:
            print(f"      ... and {len(cl['ids']) - 5} more")

    if result["clusters_found"] == 0:
        print("  No clusters found above threshold. Memory is already consolidated. ✨")


if __name__ == "__main__":
    main()
