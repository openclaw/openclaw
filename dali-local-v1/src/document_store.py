from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from memory_store import append_event, connect, utc_now

DEFAULT_SOURCE_RESEARCH_CORPUS_ID = "source_research_corpus"
DEFAULT_SOURCE_RESEARCH_CORPUS_ROOT = Path.home() / "Desktop" / "source_research_corpus"
DEFAULT_SOURCE_RESEARCH_CORPUS_TITLE = "Source Research Corpus"

_MANIFEST_PATH = Path("09_vector-db/manifest.json")
_LOCATIONS_PATH = Path("08_indexes/document_locations.csv")
_VECTOR_DB_PATH = Path("09_vector-db/lancedb")
_RECORDS_PATH = Path("03_metadata/records")

_QUERY_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


def _json_payload(payload: dict[str, Any] | list[Any] | None) -> str:
    if payload is None:
        payload = {}
    return json.dumps(payload, sort_keys=True)


def _resolve_corpus_root(corpus_root: str | Path | None) -> Path:
    root = Path(corpus_root or DEFAULT_SOURCE_RESEARCH_CORPUS_ROOT).expanduser()
    if not root.exists():
        raise FileNotFoundError(f"corpus root not found: {root}")
    return root


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _loads_json_text(value: str | None, default: Any) -> Any:
    if value is None:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _document_id(corpus_id: str, hash8: str) -> str:
    return f"{corpus_id}:{hash8}"


def _chunk_id(corpus_id: str, source_chunk_id: str) -> str:
    return f"{corpus_id}:{source_chunk_id}"


def _manifest_documents(corpus_root: Path, limit: int | None = None) -> tuple[list[dict[str, Any]], int | None]:
    manifest = _load_json(corpus_root / _MANIFEST_PATH)
    documents = list(manifest.get("documents") or [])
    if limit and limit > 0:
        documents = documents[:limit]
    return documents, manifest.get("dimension")


def import_source_research_corpus(
    db_path: str | Path,
    *,
    corpus_root: str | Path | None = None,
    corpus_id: str = DEFAULT_SOURCE_RESEARCH_CORPUS_ID,
    title: str = DEFAULT_SOURCE_RESEARCH_CORPUS_TITLE,
    limit: int | None = None,
    refresh: bool = False,
) -> dict[str, Any]:
    root = _resolve_corpus_root(corpus_root)
    documents, vector_dimension = _manifest_documents(root, limit=limit)
    manifest_path = root / _MANIFEST_PATH
    locations_path = root / _LOCATIONS_PATH
    vector_db_path = root / _VECTOR_DB_PATH

    imported_documents = 0
    imported_chunks = 0
    missing_chunk_files: list[str] = []

    with connect(db_path) as conn:
        now = utc_now()
        conn.execute(
            """
            INSERT INTO document_corpora (
              id, created_at, updated_at, title, root_path, manifest_path,
              vector_db_path, location_index_path, document_count, chunk_count, payload_json
            ) VALUES (
              :id, :created_at, :updated_at, :title, :root_path, :manifest_path,
              :vector_db_path, :location_index_path, 0, 0, :payload_json
            )
            ON CONFLICT(id) DO UPDATE SET
              updated_at = excluded.updated_at,
              title = excluded.title,
              root_path = excluded.root_path,
              manifest_path = excluded.manifest_path,
              vector_db_path = excluded.vector_db_path,
              location_index_path = excluded.location_index_path,
              payload_json = excluded.payload_json
            """,
            {
                "id": corpus_id,
                "created_at": now,
                "updated_at": now,
                "title": title,
                "root_path": str(root),
                "manifest_path": str(manifest_path),
                "vector_db_path": str(vector_db_path),
                "location_index_path": str(locations_path),
                "payload_json": _json_payload(
                    {
                        "default": corpus_id == DEFAULT_SOURCE_RESEARCH_CORPUS_ID,
                        "vectorDimension": vector_dimension,
                    }
                ),
            },
        )

        if refresh:
            conn.execute("DELETE FROM document_chunks_fts WHERE corpus_id = ?", (corpus_id,))
            conn.execute("DELETE FROM document_chunks WHERE corpus_id = ?", (corpus_id,))
            conn.execute("DELETE FROM documents WHERE corpus_id = ?", (corpus_id,))

        for item in documents:
            hash8 = str(item["hash8"])
            document_id = _document_id(corpus_id, hash8)
            record_path = root / _RECORDS_PATH / f"{hash8}.json"
            metadata = _load_json(record_path)

            conn.execute(
                """
                INSERT INTO documents (
                  id, corpus_id, hash8, title, topic, published, updated, arxiv_id,
                  abstract_url, source_url, pdf_path, raw_pdf_path, text_path,
                  markdown_path, record_path, authors_json, categories_json,
                  summary_text, payload_json
                ) VALUES (
                  :id, :corpus_id, :hash8, :title, :topic, :published, :updated, :arxiv_id,
                  :abstract_url, :source_url, :pdf_path, :raw_pdf_path, :text_path,
                  :markdown_path, :record_path, :authors_json, :categories_json,
                  :summary_text, :payload_json
                )
                ON CONFLICT(id) DO UPDATE SET
                  title = excluded.title,
                  topic = excluded.topic,
                  published = excluded.published,
                  updated = excluded.updated,
                  arxiv_id = excluded.arxiv_id,
                  abstract_url = excluded.abstract_url,
                  source_url = excluded.source_url,
                  pdf_path = excluded.pdf_path,
                  raw_pdf_path = excluded.raw_pdf_path,
                  text_path = excluded.text_path,
                  markdown_path = excluded.markdown_path,
                  record_path = excluded.record_path,
                  authors_json = excluded.authors_json,
                  categories_json = excluded.categories_json,
                  summary_text = excluded.summary_text,
                  payload_json = excluded.payload_json
                """,
                {
                    "id": document_id,
                    "corpus_id": corpus_id,
                    "hash8": hash8,
                    "title": metadata.get("title") or hash8,
                    "topic": metadata.get("topic"),
                    "published": metadata.get("published"),
                    "updated": metadata.get("updated"),
                    "arxiv_id": metadata.get("arxiv_id"),
                    "abstract_url": metadata.get("abstract_url"),
                    "source_url": metadata.get("source_url"),
                    "pdf_path": metadata.get("pdf_path"),
                    "raw_pdf_path": metadata.get("raw_pdf_path"),
                    "text_path": metadata.get("text_path"),
                    "markdown_path": metadata.get("markdown_path"),
                    "record_path": metadata.get("record_path") or str(record_path.relative_to(root)),
                    "authors_json": _json_payload(metadata.get("authors") or []),
                    "categories_json": _json_payload(metadata.get("categories") or []),
                    "summary_text": metadata.get("summary"),
                    "payload_json": _json_payload({"sha256": metadata.get("sha256")}),
                },
            )

            conn.execute("DELETE FROM document_chunks_fts WHERE document_id = ?", (document_id,))
            conn.execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))

            chunk_rows: list[tuple[Any, ...]] = []
            fts_rows: list[tuple[Any, ...]] = []
            chunk_path = root / str(item["chunk_file"])
            if chunk_path.exists():
                with chunk_path.open("r", encoding="utf-8") as handle:
                    for fallback_index, raw_line in enumerate(handle):
                        line = raw_line.strip()
                        if not line:
                            continue
                        row = json.loads(line)
                        text = (row.get("text") or "").strip()
                        if not text:
                            continue

                        source_chunk_id = str(row.get("id") or f"{hash8}::{fallback_index}")
                        chunk_index = int(
                            row.get("chunk_index") if row.get("chunk_index") is not None else fallback_index
                        )
                        vector = row.get("vector")
                        vector_dim = len(vector) if isinstance(vector, list) else None
                        stored_chunk_id = _chunk_id(corpus_id, source_chunk_id)
                        payload = {
                            "title": row.get("title"),
                            "topic": row.get("topic"),
                            "arxiv_id": row.get("arxiv_id"),
                            "pdf_path": row.get("pdf_path"),
                            "text_path": row.get("text_path"),
                        }
                        chunk_rows.append(
                            (
                                stored_chunk_id,
                                corpus_id,
                                document_id,
                                source_chunk_id,
                                chunk_index,
                                text,
                                vector_dim,
                                _json_payload(payload),
                            )
                        )
                        fts_rows.append(
                            (
                                stored_chunk_id,
                                document_id,
                                corpus_id,
                                hash8,
                                metadata.get("title") or row.get("title") or hash8,
                                metadata.get("topic") or row.get("topic") or "",
                                text,
                            )
                        )
            else:
                missing_chunk_files.append(str(chunk_path))

            conn.executemany(
                """
                INSERT INTO document_chunks (
                  id, corpus_id, document_id, source_chunk_id,
                  chunk_index, text, vector_dim, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                chunk_rows,
            )
            conn.executemany(
                """
                INSERT INTO document_chunks_fts (
                  chunk_id, document_id, corpus_id, hash8, title, topic, text
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                fts_rows,
            )
            imported_documents += 1
            imported_chunks += len(chunk_rows)

        total_documents = conn.execute(
            "SELECT COUNT(*) FROM documents WHERE corpus_id = ?",
            (corpus_id,),
        ).fetchone()[0]
        total_chunks = conn.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE corpus_id = ?",
            (corpus_id,),
        ).fetchone()[0]
        conn.execute(
            """
            UPDATE document_corpora
            SET updated_at = ?, document_count = ?, chunk_count = ?, payload_json = ?
            WHERE id = ?
            """,
            (
                utc_now(),
                int(total_documents),
                int(total_chunks),
                _json_payload(
                    {
                        "default": corpus_id == DEFAULT_SOURCE_RESEARCH_CORPUS_ID,
                        "importedDocuments": imported_documents,
                        "importedChunks": imported_chunks,
                        "limit": limit,
                        "missingChunkFiles": missing_chunk_files,
                        "refresh": refresh,
                        "vectorDimension": vector_dimension,
                    }
                ),
                corpus_id,
            ),
        )
        conn.commit()

    event = append_event(
        db_path,
        event_type="corpus_import",
        source="document_store",
        payload={
            "corpusId": corpus_id,
            "corpusRoot": str(root),
            "importedDocuments": imported_documents,
            "importedChunks": imported_chunks,
            "limit": limit,
            "missingChunkFiles": missing_chunk_files,
            "refresh": refresh,
            "vectorDimension": vector_dimension,
        },
    )
    return {
        "corpusId": corpus_id,
        "corpusRoot": str(root),
        "importedDocuments": imported_documents,
        "importedChunks": imported_chunks,
        "missingChunkFiles": missing_chunk_files,
        "totalDocuments": int(total_documents),
        "totalChunks": int(total_chunks),
        "vectorDimension": vector_dimension,
        "eventId": event["id"],
    }


def list_document_corpora(db_path: str | Path, limit: int = 10) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, updated_at, title, root_path, manifest_path,
                   vector_db_path, location_index_path, document_count, chunk_count, payload_json
            FROM document_corpora
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_documents(
    db_path: str | Path,
    *,
    corpus_id: str | None = None,
    topic: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    values: list[Any] = []
    if corpus_id:
        clauses.append("d.corpus_id = ?")
        values.append(corpus_id)
    if topic:
        clauses.append("d.topic = ?")
        values.append(topic)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT d.id, d.corpus_id, d.hash8, d.title, d.topic, d.published, d.arxiv_id,
                   d.pdf_path, d.text_path, d.markdown_path, d.record_path,
                   COUNT(c.id) AS chunk_count
            FROM documents d
            LEFT JOIN document_chunks c ON c.document_id = d.id
            {where}
            GROUP BY d.id, d.corpus_id, d.hash8, d.title, d.topic, d.published, d.arxiv_id,
                     d.pdf_path, d.text_path, d.markdown_path, d.record_path
            ORDER BY d.published DESC, d.title ASC
            LIMIT ?
            """,
            (*values, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def get_document(
    db_path: str | Path,
    *,
    document_id: str | None = None,
    hash8: str | None = None,
    corpus_id: str | None = None,
) -> dict[str, Any] | None:
    if not document_id and not hash8:
        raise ValueError("document_id or hash8 is required")

    clauses: list[str] = []
    values: list[Any] = []
    if document_id:
        clauses.append("d.id = ?")
        values.append(document_id)
    if hash8:
        clauses.append("d.hash8 = ?")
        values.append(hash8)
    if corpus_id:
        clauses.append("d.corpus_id = ?")
        values.append(corpus_id)

    where = " AND ".join(clauses)

    with connect(db_path) as conn:
        row = conn.execute(
            f"""
            SELECT d.id, d.corpus_id, d.hash8, d.title, d.topic, d.published, d.updated,
                   d.arxiv_id, d.abstract_url, d.source_url, d.pdf_path, d.raw_pdf_path,
                   d.text_path, d.markdown_path, d.record_path, d.authors_json,
                   d.categories_json, d.summary_text, d.payload_json,
                   COUNT(c.id) AS chunk_count
            FROM documents d
            LEFT JOIN document_chunks c ON c.document_id = d.id
            WHERE {where}
            GROUP BY d.id, d.corpus_id, d.hash8, d.title, d.topic, d.published, d.updated,
                     d.arxiv_id, d.abstract_url, d.source_url, d.pdf_path, d.raw_pdf_path,
                     d.text_path, d.markdown_path, d.record_path, d.authors_json,
                     d.categories_json, d.summary_text, d.payload_json
            LIMIT 1
            """,
            tuple(values),
        ).fetchone()

    if row is None:
        return None

    payload = dict(row)
    payload["authors"] = _loads_json_text(payload.pop("authors_json", None), [])
    payload["categories"] = _loads_json_text(payload.pop("categories_json", None), [])
    payload["payload"] = _loads_json_text(payload.pop("payload_json", None), {})
    return payload


def list_document_chunks_for_document(
    db_path: str | Path,
    *,
    document_id: str | None = None,
    hash8: str | None = None,
    corpus_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    if not document_id and not hash8:
        raise ValueError("document_id or hash8 is required")

    clauses: list[str] = []
    values: list[Any] = []
    if document_id:
        clauses.append("c.document_id = ?")
        values.append(document_id)
    if hash8:
        clauses.append("d.hash8 = ?")
        values.append(hash8)
    if corpus_id:
        clauses.append("c.corpus_id = ?")
        values.append(corpus_id)

    where = " AND ".join(clauses)

    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT c.id, c.corpus_id, c.document_id, c.source_chunk_id, c.chunk_index,
                   c.text, c.vector_dim, c.payload_json,
                   d.hash8, d.title, d.topic, d.published, d.arxiv_id
            FROM document_chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE {where}
            ORDER BY c.chunk_index ASC
            LIMIT ?
            """,
            (*values, limit),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for row in rows:
        payload = dict(row)
        payload["payload"] = _loads_json_text(payload.pop("payload_json", None), {})
        results.append(payload)
    return results


def _normalize_fts_query(query: str) -> str:
    tokens = _QUERY_TOKEN_RE.findall((query or "").lower())
    if not tokens:
        raise ValueError("query must include at least one alphanumeric token")
    deduped = list(dict.fromkeys(tokens))
    return " OR ".join(deduped)


def search_document_chunks(
    db_path: str | Path,
    *,
    query: str,
    corpus_id: str | None = None,
    topic: str | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    match_query = _normalize_fts_query(query)
    clauses = ["document_chunks_fts MATCH ?"]
    values: list[Any] = [match_query]
    if corpus_id:
        clauses.append("c.corpus_id = ?")
        values.append(corpus_id)
    if topic:
        clauses.append("d.topic = ?")
        values.append(topic)
    where = " AND ".join(clauses)

    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT c.id, c.corpus_id, c.document_id, c.source_chunk_id, c.chunk_index,
                   d.hash8, d.title, d.topic, d.published, d.arxiv_id,
                   d.pdf_path, d.text_path,
                   snippet(document_chunks_fts, 6, '<<', '>>', ' ... ', 18) AS snippet,
                   bm25(document_chunks_fts, 1.0, 0.5, 2.0) AS score
            FROM document_chunks_fts
            JOIN document_chunks c ON c.id = document_chunks_fts.chunk_id
            JOIN documents d ON d.id = c.document_id
            WHERE {where}
            ORDER BY score ASC, d.published DESC
            LIMIT ?
            """,
            (*values, limit),
        ).fetchall()
    return [dict(row) for row in rows]
