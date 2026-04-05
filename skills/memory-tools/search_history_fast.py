#!/usr/bin/env python3
# Copyright (c) 2026 Arthur Arsyonov — looi.ru
# Licensed under MIT
"""
Fast hybrid semantic+lexical search over ~/.openclaw/memory/chat_vectors.db.

CLI is intentionally unchanged:
    python3 search_history_fast.py <query> [top_k]

Key ideas:
- Persistent on-disk cache of normalized embedding matrix (numpy memmap).
- Cache key includes DB file size/mtime + embedding dims.
- Lightweight lexical prefilter using SQLite FTS5 (with plain SQL fallback).
- Hybrid scoring (vector + lexical) and robust fallback when embedding provider fails.
- Dedupe by message_id and near-duplicate chunk text.
"""

import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import urllib.request

VEC_DB = Path.home() / ".openclaw/memory/chat_vectors.db"
CFG = Path.home() / ".openclaw/openclaw.json"
CACHE_DIR = Path.home() / ".openclaw/memory/.search_cache"
GOOGLE_MODEL = "models/gemini-embedding-2-preview"
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
MAX_TOP_K = 15

# Limits chosen for quality/speed balance on ~58k chunks.
LEXICAL_CANDIDATES = 1200
VECTOR_CANDIDATES = 900


@dataclass
class CacheBundle:
    chunk_ids: np.ndarray
    message_ids: np.ndarray
    conv_ids: np.ndarray
    chunk_indexes: np.ndarray
    matrix: np.memmap


def get_key():
    try:
        return json.loads(CFG.read_text())["env"]["vars"]["GOOGLE_AI_API_KEY"]
    except Exception:
        return None


def embed_google(text, key):
    url = f"https://generativelanguage.googleapis.com/v1beta/{GOOGLE_MODEL}:embedContent"
    payload = json.dumps({"model": GOOGLE_MODEL, "content": {"parts": [{"text": text[:8000]}]}}).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "x-goog-api-key": key,
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read())
    return d["embedding"]["values"]


def embed_ollama(text):
    url = f"{OLLAMA_HOST}/api/embeddings"
    payload = json.dumps({"model": "nomic-embed-text", "prompt": text[:4000]}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.loads(r.read())
    return d["embedding"]


def embed_query(query: str) -> np.ndarray | None:
    """Try providers in order; return normalized vector or None on total failure."""
    emb = None
    key = get_key()

    if key:
        try:
            emb = embed_google(query, key)
        except Exception:
            emb = None

    if emb is None:
        try:
            emb = embed_ollama(query)
        except Exception:
            emb = None

    if emb is None:
        return None

    q = np.asarray(emb, dtype=np.float32)
    n = np.linalg.norm(q)
    if n == 0:
        return None
    return q / n


def db_signature() -> dict:
    st = VEC_DB.stat()
    return {
        "path": str(VEC_DB),
        "size": int(st.st_size),
        "mtime_ns": int(st.st_mtime_ns),
    }


def cache_prefix(sig: dict, dims: int) -> str:
    src = f"{sig['path']}|{sig['size']}|{sig['mtime_ns']}|{dims}"
    return hashlib.sha1(src.encode()).hexdigest()[:16]


def _conn():
    conn = sqlite3.connect(str(VEC_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def count_rows(conn: sqlite3.Connection, dims: int) -> int:
    return int(
        conn.execute("SELECT COUNT(*) FROM chunks WHERE length(embedding)=?", (dims * 4,)).fetchone()[0]
    )


def build_cache(dims: int, sig: dict, prefix: str) -> CacheBundle:
    """One-time expensive path: read BLOB vectors, normalize, and store mmap + id arrays."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    meta_path = CACHE_DIR / f"{prefix}.meta.json"
    matrix_path = CACHE_DIR / f"{prefix}.matrix.f32"
    ids_path = CACHE_DIR / f"{prefix}.ids.npz"

    conn = _conn()
    total = count_rows(conn, dims)
    if total == 0:
        conn.close()
        raise RuntimeError(f"No vectors with dims={dims} in index")

    matrix = np.memmap(matrix_path, dtype=np.float32, mode="w+", shape=(total, dims))
    chunk_ids = np.empty(total, dtype=np.int64)
    message_ids = np.empty(total, dtype=np.int64)
    conv_ids = np.empty(total, dtype=np.int64)
    chunk_indexes = np.empty(total, dtype=np.int32)

    sql = (
        "SELECT chunk_id, message_id, conv_id, chunk_index, embedding "
        "FROM chunks WHERE length(embedding)=? ORDER BY chunk_id"
    )
    cur = conn.execute(sql, (dims * 4,))

    i = 0
    for chunk_id, message_id, conv_id, chunk_index, blob in cur:
        vec = np.frombuffer(blob, dtype=np.float32, count=dims)
        n = np.linalg.norm(vec)
        if n <= 0:
            continue
        matrix[i] = vec / n
        chunk_ids[i] = int(chunk_id)
        message_ids[i] = int(message_id)
        conv_ids[i] = int(conv_id)
        chunk_indexes[i] = int(chunk_index)
        i += 1

    conn.close()

    if i < total:
        # Rare case: zero vectors dropped. Keep arrays compact and rewrite memmap.
        matrix.flush()
        compact = np.memmap(matrix_path, dtype=np.float32, mode="r", shape=(total, dims))[:i].copy()
        del matrix
        matrix = np.memmap(matrix_path, dtype=np.float32, mode="w+", shape=(i, dims))
        matrix[:] = compact
        total = i
        chunk_ids = chunk_ids[:i]
        message_ids = message_ids[:i]
        conv_ids = conv_ids[:i]
        chunk_indexes = chunk_indexes[:i]

    matrix.flush()
    np.savez_compressed(
        ids_path,
        chunk_ids=chunk_ids,
        message_ids=message_ids,
        conv_ids=conv_ids,
        chunk_indexes=chunk_indexes,
        total=np.asarray([total], dtype=np.int64),
        dims=np.asarray([dims], dtype=np.int64),
    )

    meta_path.write_text(
        json.dumps(
            {
                "signature": sig,
                "dims": dims,
                "total": total,
                "matrix": str(matrix_path),
                "ids": str(ids_path),
                "built_at": int(time.time()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    return CacheBundle(
        chunk_ids=chunk_ids,
        message_ids=message_ids,
        conv_ids=conv_ids,
        chunk_indexes=chunk_indexes,
        matrix=np.memmap(matrix_path, dtype=np.float32, mode="r", shape=(total, dims)),
    )


def load_or_build_cache(dims: int) -> CacheBundle:
    sig = db_signature()
    prefix = cache_prefix(sig, dims)
    meta_path = CACHE_DIR / f"{prefix}.meta.json"

    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
            ids_npz = np.load(meta["ids"])
            total = int(meta["total"])
            dims_meta = int(meta["dims"])
            if dims_meta != dims:
                raise ValueError("dims mismatch")
            return CacheBundle(
                chunk_ids=ids_npz["chunk_ids"],
                message_ids=ids_npz["message_ids"],
                conv_ids=ids_npz["conv_ids"],
                chunk_indexes=ids_npz["chunk_indexes"],
                matrix=np.memmap(meta["matrix"], dtype=np.float32, mode="r", shape=(total, dims)),
            )
        except Exception:
            # Corrupted/stale cache: rebuild.
            pass

    return build_cache(dims=dims, sig=sig, prefix=prefix)


def tokens_for_query(text: str) -> list[str]:
    # Keep simple alnum tokens (both Latin/Cyrillic); drop tiny tokens.
    toks = re.findall(r"[\w\-]{2,}", text.lower())
    # Stable unique order
    seen = set()
    out = []
    for t in toks:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out[:8]


def ensure_fts(conn: sqlite3.Connection):
    """Create and incrementally sync FTS table once; cheap on later runs."""
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='chunk_id')"
    )
    max_rowid = conn.execute("SELECT COALESCE(MAX(rowid),0) FROM chunks_fts").fetchone()[0]
    max_chunk = conn.execute("SELECT COALESCE(MAX(chunk_id),0) FROM chunks").fetchone()[0]
    if max_rowid < max_chunk:
        conn.execute(
            "INSERT INTO chunks_fts(rowid, text) SELECT chunk_id, text FROM chunks WHERE chunk_id > ?",
            (max_rowid,),
        )
        conn.commit()


def lexical_candidates(conn: sqlite3.Connection, query: str, limit: int = LEXICAL_CANDIDATES):
    toks = tokens_for_query(query)
    if not toks:
        return {}

    scores = {}

    # Try FTS5 first (best speed/quality).
    try:
        ensure_fts(conn)
        match_expr = " OR ".join([f'"{t}"' for t in toks])
        rows = conn.execute(
            "SELECT rowid, bm25(chunks_fts) AS b FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY b LIMIT ?",
            (match_expr, limit),
        ).fetchall()
        # bm25() is lower=better; convert to monotonic positive score.
        for rank, (cid, b) in enumerate(rows, 1):
            base = 1.0 / (1.0 + max(float(b), 0.0))
            rr = 1.0 / (rank + 10)
            scores[int(cid)] = base + rr
    except Exception:
        # Fallback: plain LIKE query (slower, but robust).
        wheres = " OR ".join(["lower(text) LIKE ?" for _ in toks])
        if wheres:
            params = [f"%{t}%" for t in toks] + [limit]
            rows = conn.execute(
                f"SELECT chunk_id FROM chunks WHERE {wheres} ORDER BY chunk_id DESC LIMIT ?", params
            ).fetchall()
            for rank, (cid,) in enumerate(rows, 1):
                scores[int(cid)] = 1.0 / (rank + 5)

    return scores


def candidate_row_indices(chunk_ids_sorted: np.ndarray, wanted_chunk_ids: Iterable[int]) -> np.ndarray:
    wanted = np.asarray(sorted(set(int(x) for x in wanted_chunk_ids)), dtype=np.int64)
    if wanted.size == 0:
        return np.empty((0,), dtype=np.int64)
    pos = np.searchsorted(chunk_ids_sorted, wanted)
    ok = (pos < len(chunk_ids_sorted)) & (chunk_ids_sorted[pos] == wanted)
    return pos[ok]


def normalize_text_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", text.lower())).strip()[:200]


def is_noisy_chunk(text: str) -> bool:
    if not text:
        return True
    t = text.strip()
    lower = t.lower()

    noise_markers = [
        '"type":"toolcall"',
        '"thinkingsignature"',
        'toolcall","id"',
        'partialjson',
        'conversation info (untrusted metadata)',
        'sender (untrusted metadata)',
        '[lc m fallback summary'.replace(' ', ''),
        'read heartbeat.md if it exists',
        'openclaw runtime context (internal)',
        '<<<begin_untrusted_child_result>>>',
        'base64 image data',
        'data:image/',
        'eyjhbgcioi',
    ]
    compact = lower.replace(' ', '')
    if any(m.replace(' ', '') in compact for m in noise_markers):
        return True

    if len(t) > 1500 and ('{"' in t or '[{"' in t or '/9j/' in t):
        return True

    if re.search(r'/9j/[A-Za-z0-9+/]{200,}', t):
        return True

    # Long encoded / encrypted-looking blobs with almost no whitespace are never useful recall.
    if len(t) > 300:
        ws_ratio = sum(ch.isspace() for ch in t) / max(len(t), 1)
        if ws_ratio < 0.04:
            return True
        if re.search(r'[A-Za-z0-9_\-/+=]{180,}', t):
            return True

    return False


def clean_preview(text: str, limit: int = 700) -> str:
    t = re.sub(r'\s+', ' ', (text or '').strip())
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + '…'


def fetch_details(conn: sqlite3.Connection, chunk_ids: list[int]):
    if not chunk_ids:
        return {}
    ph = ",".join("?" for _ in chunk_ids)
    rows = conn.execute(
        f"SELECT chunk_id, message_id, role, text, created_at, chunk_index FROM chunks WHERE chunk_id IN ({ph})",
        chunk_ids,
    ).fetchall()
    return {
        int(cid): {
            "message_id": int(mid),
            "role": role or "",
            "text": text or "",
            "created_at": created_at or "",
            "chunk_index": int(cidx or 0),
        }
        for cid, mid, role, text, created_at, cidx in rows
    }


def hybrid_search(query: str, top_k: int):
    emb = embed_query(query)

    conn = _conn()
    lex_scores = lexical_candidates(conn, query)

    # If embedding unavailable, graceful lexical-only path.
    if emb is None:
        ranked = sorted(lex_scores.items(), key=lambda kv: kv[1], reverse=True)[: top_k * 6]
        details = fetch_details(conn, [cid for cid, _ in ranked])
        conn.close()
        return dedupe_and_format(ranked, details, top_k, score_label="lex")

    dims = int(emb.shape[0])
    cache = load_or_build_cache(dims)

    vec_scores = None
    candidate_idx = None
    if lex_scores:
        candidate_idx = candidate_row_indices(cache.chunk_ids, lex_scores.keys())

    # Prefer vector scoring on lexical shortlist; otherwise full matrix.
    if candidate_idx is not None and len(candidate_idx) >= max(top_k * 4, 40):
        local_scores = cache.matrix[candidate_idx] @ emb
        take = min(VECTOR_CANDIDATES, len(local_scores))
        best_local = np.argpartition(-local_scores, take - 1)[:take]
        vec_scores = {
            int(cache.chunk_ids[candidate_idx[i]]): float(local_scores[i])
            for i in best_local
        }
    else:
        all_scores = cache.matrix @ emb
        take = min(VECTOR_CANDIDATES, len(all_scores))
        best = np.argpartition(-all_scores, take - 1)[:take]
        vec_scores = {int(cache.chunk_ids[i]): float(all_scores[i]) for i in best}

    # Merge candidate sets from both channels.
    all_ids = set(vec_scores.keys()) | set(lex_scores.keys())
    combined = []
    for cid in all_ids:
        v = vec_scores.get(cid, 0.0)
        l = lex_scores.get(cid, 0.0)
        # Hybrid blending. Vector dominates, lexical nudges relevance.
        score = 0.78 * v + 0.22 * l
        combined.append((cid, score, v, l))

    combined.sort(key=lambda x: x[1], reverse=True)
    details = fetch_details(conn, [cid for cid, *_ in combined[: top_k * 10]])
    conn.close()

    ranked = [(cid, s) for cid, s, _, _ in combined]
    return dedupe_and_format(ranked, details, top_k, score_label="hybrid")


def dedupe_and_format(ranked: list[tuple[int, float]], details: dict, top_k: int, score_label: str):
    out = []
    seen_msg = set()
    seen_text = set()

    for cid, score in ranked:
        d = details.get(cid)
        if not d:
            continue

        msg_id = d["message_id"]
        if msg_id in seen_msg:
            continue

        if is_noisy_chunk(d["text"]):
            continue

        key = normalize_text_key(d["text"])
        if key and key in seen_text:
            continue

        seen_msg.add(msg_id)
        if key:
            seen_text.add(key)

        out.append(
            {
                "chunk_id": cid,
                "message_id": msg_id,
                "role": d["role"],
                "text": clean_preview(d["text"]),
                "created_at": d["created_at"],
                "score": float(score),
                "score_label": score_label,
            }
        )

        if len(out) >= top_k:
            break

    return out


def main():
    if len(sys.argv) < 2:
        print("Usage: search_history_fast.py <query> [top_k]", file=sys.stderr)
        sys.exit(2)

    query = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    top_k = max(1, min(top_k, MAX_TOP_K))

    if not VEC_DB.exists():
        print(f"Vector DB not found: {VEC_DB}", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    try:
        results = hybrid_search(query, top_k)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    print(f"Search: {query}\n")
    for rank, item in enumerate(results, 1):
        date = item["created_at"][:10] if item["created_at"] else "?"
        icon = "👤" if item["role"] == "user" else "🤖"
        print(f"[{rank}] {icon} {date} score={item['score']:.3f} ({item['score_label']})")
        print(item["text"].strip())
        print()

    took = time.time() - t0
    print(f"-- took {took:.2f}s")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
