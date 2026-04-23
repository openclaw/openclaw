from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    owners_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    service TEXT,
    feature TEXT,
    plugin TEXT,
    environments_json TEXT NOT NULL,
    validation_last_validated_at TEXT,
    validation_review_interval_days INTEGER,
    provenance_json TEXT NOT NULL,
    synopsis TEXT NOT NULL DEFAULT '',
    retrieval_hints_json TEXT NOT NULL DEFAULT '[]',
    not_for_json TEXT NOT NULL DEFAULT '[]',
    commands_json TEXT NOT NULL DEFAULT '[]',
    source_path TEXT,
    source_ref TEXT,
    canonical_path TEXT,
    content_checksum TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_aliases (
    alias TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id TEXT NOT NULL UNIQUE,
    doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    section_path TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
    chunk_id,
    doc_id,
    title,
    section_path,
    text
);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    model_name TEXT NOT NULL,
    vector_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
    doc_id TEXT PRIMARY KEY REFERENCES documents(doc_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    purpose TEXT NOT NULL,
    when_to_use TEXT NOT NULL,
    key_scope TEXT NOT NULL,
    key_tokens_json TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    last_validated_at TEXT,
    related_docs_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS section_summaries (
    summary_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    section_path TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
CREATE INDEX IF NOT EXISTS idx_documents_type_lifecycle ON documents(type, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(service, plugin, feature);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_section_summaries_doc_id ON section_summaries(doc_id);
"""

DOCUMENT_COLUMN_DEFAULTS = {
    "aliases_json": "'[]'",
    "synopsis": "''",
    "retrieval_hints_json": "'[]'",
    "not_for_json": "'[]'",
    "commands_json": "'[]'",
}


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    columns = {
        row["name"] if isinstance(row, sqlite3.Row) else row[1]
        for row in conn.execute("PRAGMA table_info(documents)").fetchall()
    }
    for column_name, default_sql in DOCUMENT_COLUMN_DEFAULTS.items():
        if column_name in columns:
            continue
        conn.execute(
            f"ALTER TABLE documents ADD COLUMN {column_name} TEXT NOT NULL DEFAULT {default_sql}"
        )


def open_database(db_path: Path) -> sqlite3.Connection:
    conn = connect(db_path)
    ensure_schema(conn)
    return conn
