#!/usr/bin/env python3
# Copyright (c) 2026 Arthur Arsyonov — looi.ru
# Licensed under MIT
"""
Build vector index over lcm.db chat history using Google gemini-embedding-2-preview.
Fallback: Ollama nomic-embed-text if Google API unavailable.
Stores embeddings in ~/.openclaw/memory/chat_vectors.db (SQLite).

Usage:
  python3 build_vector_index.py          # full rebuild
  python3 build_vector_index.py --update # only index new messages
"""

import sqlite3
import json
import urllib.request
import struct
import math
import argparse
import sys
import time
import os
from pathlib import Path

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = "nomic-embed-text"
GOOGLE_EMBED_MODEL = "models/gemini-embedding-2-preview"
GOOGLE_EMBED_DIMS = 3072
LCM_DB = Path.home() / ".openclaw/lcm.db"
VEC_DB = Path.home() / ".openclaw/memory/chat_vectors.db"
CHUNK_SIZE = 600       # chars per chunk
CHUNK_OVERLAP = 100    # overlap between chunks
BATCH_SIZE = 20        # texts per API batch (Google batchEmbedContents)

def _get_google_api_key() -> str:
    cfg_path = Path.home() / ".openclaw/openclaw.json"
    cfg = json.loads(cfg_path.read_text())
    return cfg["env"]["vars"]["GOOGLE_AI_API_KEY"]

def _google_available() -> bool:
    try:
        key = _get_google_api_key()
        return bool(key)
    except Exception:
        return False

def ollama_available() -> bool:
    """Check if Ollama is reachable."""
    try:
        urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=3)
        return True
    except Exception:
        return False

def get_embedding(texts: list[str]) -> list[list[float]]:
    """Get embeddings. Primary: Google gemini-embedding-2-preview. Fallback: Ollama.

    If Google is available but the request fails (quota, network), falls back to Ollama
    rather than silently dropping the batch.
    """
    if _google_available():
        try:
            return _google_embed(texts)
        except Exception as exc:
            print(f"WARNING: Google embedding failed ({exc}), trying Ollama fallback", file=sys.stderr)
            if ollama_available():
                return _ollama_embed(texts)
            raise RuntimeError(f"Google failed ({exc}) and Ollama unreachable") from exc
    elif ollama_available():
        return _ollama_embed(texts)
    else:
        raise RuntimeError("No embedding provider available (Google API key missing, Ollama unreachable)")

def _google_embed(texts: list[str]) -> list[list[float]]:
    """Batch embed via Google gemini-embedding-2-preview."""
    key = _get_google_api_key()
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:batchEmbedContents"
    requests = [
        {"model": GOOGLE_EMBED_MODEL, "content": {"parts": [{"text": t}]}}
        for t in texts
    ]
    payload = json.dumps({"requests": requests}).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "x-goog-api-key": key,
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    return [e["values"] for e in result["embeddings"]]

def _ollama_embed(texts: list[str]) -> list[list[float]]:
    """Fallback: embed via Ollama nomic-embed-text."""
    payload = json.dumps({"model": OLLAMA_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["embeddings"]

def cosine_sim(a: list[float], b: list[float]) -> float:
    dot = sum(x*y for x,y in zip(a,b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(x*x for x in b))
    return dot / (na * nb) if na and nb else 0.0

def pack_vector(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)

def unpack_vector(blob: bytes) -> list[float]:
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))

def chunk_text(text: str) -> list[str]:
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks

def init_vec_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id  INTEGER NOT NULL,
            conv_id     INTEGER NOT NULL,
            role        TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text        TEXT NOT NULL,
            created_at  TEXT,
            embedding   BLOB NOT NULL,
            UNIQUE(message_id, chunk_index)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_message ON chunks(message_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_conv ON chunks(conv_id)")
    conn.commit()

def get_indexed_message_ids(vec_conn) -> set:
    rows = vec_conn.execute("SELECT DISTINCT message_id FROM chunks").fetchall()
    return {r[0] for r in rows}

def load_messages(lcm_conn, skip_ids: set) -> list[dict]:
    rows = lcm_conn.execute("""
        SELECT m.message_id, m.conversation_id, m.role, m.content, m.created_at
        FROM messages m
        WHERE m.role IN ('user', 'assistant')
        ORDER BY m.message_id
    """).fetchall()
    result = []
    for msg_id, conv_id, role, content, created_at in rows:
        if msg_id in skip_ids:
            continue
        # skip system/tool noise and very short messages
        if len(content.strip()) < 20:
            continue
        # skip session startup boilerplate
        if content.startswith("A new session was started via /new"):
            continue
        result.append({
            "message_id": msg_id,
            "conv_id": conv_id,
            "role": role,
            "content": content.strip(),
            "created_at": created_at,
        })
    return result

def build_index(update_only=False):
    if not _google_available() and not ollama_available():
        print("⚠️  No embedding provider available — skipping.")
        sys.exit(0)

    VEC_DB.parent.mkdir(parents=True, exist_ok=True)

    vec_conn = sqlite3.connect(str(VEC_DB))
    init_vec_db(vec_conn)

    lcm_conn = sqlite3.connect(str(LCM_DB))
    lcm_conn.row_factory = sqlite3.Row

    skip_ids = get_indexed_message_ids(vec_conn) if update_only else set()
    messages = load_messages(lcm_conn, skip_ids)
    lcm_conn.close()

    if not messages:
        print("Nothing to index.")
        return

    # Build (chunk, metadata) pairs
    all_chunks = []
    for msg in messages:
        for i, chunk_text_val in enumerate(chunk_text(msg["content"])):
            all_chunks.append({
                "message_id": msg["message_id"],
                "conv_id": msg["conv_id"],
                "role": msg["role"],
                "chunk_index": i,
                "text": chunk_text_val,
                "created_at": msg.get("created_at"),
            })

    total = len(all_chunks)
    print(f"Indexing {total} chunks from {len(messages)} messages...")

    indexed = 0
    for batch_start in range(0, total, BATCH_SIZE):
        batch = all_chunks[batch_start:batch_start + BATCH_SIZE]
        texts = [c["text"] for c in batch]
        try:
            embeddings = get_embedding(texts)
        except Exception as e:
            print(f"  ⚠️ embed error at {batch_start}: {e}")
            time.sleep(2)
            continue

        rows = []
        for chunk, emb in zip(batch, embeddings):
            rows.append((
                chunk["message_id"],
                chunk["conv_id"],
                chunk["role"],
                chunk["chunk_index"],
                chunk["text"],
                chunk["created_at"],
                pack_vector(emb),
            ))

        vec_conn.executemany("""
            INSERT OR IGNORE INTO chunks
              (message_id, conv_id, role, chunk_index, text, created_at, embedding)
            VALUES (?,?,?,?,?,?,?)
        """, rows)
        vec_conn.commit()
        indexed += len(batch)

        pct = indexed * 100 // total
        print(f"  {pct}% ({indexed}/{total})", end="\r", flush=True)

    print(f"\n✅ Done. Indexed {indexed}/{total} chunks.")
    vec_conn.close()


RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"

def rerank(query: str, candidates: list, top_k: int) -> list:
    """Rerank candidates using CrossEncoder. Returns top_k sorted by relevance."""
    try:
        import torch
        from sentence_transformers import CrossEncoder
        model = CrossEncoder(RERANKER_MODEL, activation_fn=torch.nn.Sigmoid())
        pairs = [(query, c[4]) for c in candidates]  # (query, text)
        scores = model.predict(pairs)
        ranked = sorted(zip(scores, candidates), key=lambda x: float(x[0]), reverse=True)
        return [c for _, c in ranked[:top_k]]
    except ImportError:
        # sentence-transformers not installed — skip reranking
        return candidates[:top_k]
    except Exception as e:
        print(f"  ⚠️ Reranker error: {e} — using vector scores")
        return candidates[:top_k]


def search(query: str, top_k: int = 5):
    if not VEC_DB.exists():
        print("Vector DB not found. Run build_vector_index.py first.")
        sys.exit(1)

    print(f"Embedding query...")
    emb = get_embedding([query])[0]

    conn = sqlite3.connect(str(VEC_DB))
    rows = conn.execute(
        "SELECT chunk_id, message_id, conv_id, role, text, created_at, embedding FROM chunks"
    ).fetchall()
    conn.close()

    scored = []
    for chunk_id, msg_id, conv_id, role, text, created_at, blob in rows:
        vec = unpack_vector(blob)
        score = cosine_sim(emb, vec)
        scored.append((score, msg_id, conv_id, role, text, created_at))

    scored.sort(reverse=True)
    # Fast mode by default: vector-only ranking.
    # Set SEARCH_HISTORY_RERANK=1 to enable slower CrossEncoder reranking.
    use_rerank = os.getenv("SEARCH_HISTORY_RERANK", "0") == "1"
    if use_rerank:
        candidates = scored[:top_k * 4]
        top = rerank(query, candidates, top_k)
        mode_label = "vector→rerank"
    else:
        top = scored[:top_k]
        mode_label = "vector-only"

    print(f"\n🔍 Top {top_k} results for: \"{query}\" ({mode_label})\n")
    for item in top:
        score, msg_id, conv_id, role, text, created_at = item
        date = (created_at or "")[:10]
        print(f"[{float(score):.3f}] msg:{msg_id} conv:{conv_id} {role} {date}")
        print(f"  {text[:200].replace(chr(10),' ')}")
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--update", action="store_true", help="Only index new messages")
    parser.add_argument("--search", type=str, help="Search query")
    parser.add_argument("--top", type=int, default=5, help="Top K results")
    args = parser.parse_args()

    if args.search:
        search(args.search, args.top)
    else:
        build_index(update_only=args.update)
