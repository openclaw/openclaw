from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  source_host TEXT NOT NULL,
  source_file TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  why TEXT NOT NULL,
  how_to_apply TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  stability TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_bindings (
  binding_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_host TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_revision_mtime REAL NOT NULL,
  source_revision_hash TEXT NOT NULL,
  binding_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS writeback_jobs (
  job_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_host TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_queue (
  review_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_host TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_host TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
  memory_id,
  summary,
  content,
  tokenize='unicode61'
);
"""


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def upsert_memory_record(db_path: Path, record: dict) -> None:
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO memory_records (
          memory_id, canonical_key, source_host, source_file, memory_type, status,
          summary, content, why, how_to_apply, risk_level, stability,
          confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          canonical_key=excluded.canonical_key,
          source_host=excluded.source_host,
          source_file=excluded.source_file,
          memory_type=excluded.memory_type,
          status=excluded.status,
          summary=excluded.summary,
          content=excluded.content,
          why=excluded.why,
          how_to_apply=excluded.how_to_apply,
          risk_level=excluded.risk_level,
          stability=excluded.stability,
          confidence=excluded.confidence,
          updated_at=excluded.updated_at
        """,
        (
            record["memory_id"],
            record["canonical_key"],
            record["source_host"],
            record.get("source_file", ""),
            record["memory_type"],
            record["status"],
            record["summary"],
            record["content"],
            record.get("why", ""),
            record.get("how_to_apply", ""),
            record["risk_level"],
            record["stability"],
            record["confidence"],
            record["created_at"],
            record["updated_at"],
        ),
    )
    conn.execute("DELETE FROM memory_records_fts WHERE memory_id = ?", (record["memory_id"],))
    conn.execute(
        "INSERT INTO memory_records_fts(memory_id, summary, content) VALUES (?, ?, ?)",
        (record["memory_id"], record["summary"], record["content"]),
    )
    conn.commit()
    conn.close()


def get_memory_record_by_canonical_key(db_path: Path, canonical_key: str) -> dict | None:
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        """
        SELECT memory_id, canonical_key, source_host, source_file, memory_type, status,
               summary, content, why, how_to_apply, risk_level, stability,
               confidence, created_at, updated_at
        FROM memory_records
        WHERE canonical_key = ? AND status IN ('active', 'candidate')
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        (canonical_key,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_source_bindings(db_path: Path, memory_id: str) -> list[dict]:
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT binding_id, memory_id, source_host, source_file,
               source_revision_mtime, source_revision_hash,
               binding_status, created_at, updated_at
        FROM source_bindings
        WHERE memory_id = ? AND binding_status = 'active'
        ORDER BY source_host, source_file
        """,
        (memory_id,),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def upsert_source_binding(db_path: Path, binding: dict) -> None:
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO source_bindings (
          binding_id, memory_id, source_host, source_file, source_revision_mtime,
          source_revision_hash, binding_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_id) DO UPDATE SET
          memory_id=excluded.memory_id,
          source_host=excluded.source_host,
          source_file=excluded.source_file,
          source_revision_mtime=excluded.source_revision_mtime,
          source_revision_hash=excluded.source_revision_hash,
          binding_status=excluded.binding_status,
          updated_at=excluded.updated_at
        """,
        (
            binding["binding_id"],
            binding["memory_id"],
            binding["source_host"],
            binding["source_file"],
            binding["source_revision_mtime"],
            binding["source_revision_hash"],
            binding["binding_status"],
            binding["created_at"],
            binding["updated_at"],
        ),
    )
    conn.commit()
    conn.close()


def search_memories(db_path: Path, query: str) -> list[dict]:
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    fts_query = query if " " in query else f'"{query}"'
    rows = conn.execute(
        """
        SELECT mr.memory_id, mr.summary, mr.content, mr.source_host, mr.memory_type
        FROM memory_records_fts fts
        JOIN memory_records mr ON mr.memory_id = fts.memory_id
        WHERE memory_records_fts MATCH ?
        ORDER BY bm25(memory_records_fts), mr.updated_at DESC
        """,
        (fts_query,),
    ).fetchall()
    if not rows:
        rows = conn.execute(
            """
            SELECT mr.memory_id, mr.summary, mr.content, mr.source_host, mr.memory_type
            FROM memory_records mr
            WHERE mr.summary LIKE ? OR mr.content LIKE ?
            ORDER BY mr.updated_at DESC
            """,
            (f"%{query}%", f"%{query}%"),
        ).fetchall()
    conn.close()
    return [dict(row) for row in rows]
