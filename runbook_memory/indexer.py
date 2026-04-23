from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .frontmatter import (
    ParsedDocument,
    alias_candidates,
    build_default_frontmatter,
    dump_frontmatter,
    ensure_frontmatter_document,
    parse_frontmatter,
    validate_frontmatter,
)
from .schema import ensure_schema
from .semantic import EmbeddingBackend
from .utils import ensure_dir, iter_markdown_files, now_iso, normalize_whitespace, sha256_text, slugify

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)

@dataclass(slots=True)
class ChunkRecord:
    chunk_id: str
    doc_id: str
    section_path: str
    ordinal: int
    text: str
    token_count: int


def load_document(path: Path) -> ParsedDocument:
    parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
    metadata = validate_frontmatter(parsed.metadata) if parsed.metadata else {}
    return ParsedDocument(metadata=metadata, body=parsed.body)


def guess_type_from_path(path: Path) -> str:
    stem = path.stem.lower()
    if "incident" in stem or "troubleshoot" in stem or "error" in stem:
        return "incident_runbook"
    if "plugin" in stem:
        return "plugin_runbook"
    if "change" in stem or "migration" in stem:
        return "change_record"
    if "ops" in stem or "sop" in stem:
        return "ops_sop"
    return "troubleshooting_note"


def chunk_markdown(body: str, max_chars: int = 1200) -> list[tuple[str, str]]:
    lines = body.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_title = "Body"
    current_lines: list[str] = []
    for line in lines:
        match = HEADING_RE.match(line)
        if match:
            if current_lines:
                sections.append((current_title, current_lines))
            current_title = match.group(2).strip()
            current_lines = []
            continue
        current_lines.append(line)
    if current_lines:
        sections.append((current_title, current_lines))

    chunks: list[tuple[str, str]] = []
    for section_title, section_lines in sections:
        block = "\n".join(section_lines).strip()
        if not block:
            continue
        pieces: list[str] = []
        buf: list[str] = []
        for paragraph in re.split(r"\n\s*\n", block):
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            if len(paragraph) > max_chars:
                if buf:
                    pieces.append("\n\n".join(buf).strip())
                    buf = []
                for start in range(0, len(paragraph), max_chars):
                    pieces.append(paragraph[start : start + max_chars])
                continue
            prospective = "\n\n".join(buf + [paragraph]).strip()
            if len(prospective) > max_chars and buf:
                pieces.append("\n\n".join(buf).strip())
                buf = [paragraph]
            else:
                buf.append(paragraph)
        if buf:
            pieces.append("\n\n".join(buf).strip())
        for index, piece in enumerate(pieces):
            path = section_title if len(pieces) == 1 else f"{section_title} [{index + 1}]"
            chunks.append((path, piece))
    return chunks or [("Body", body.strip())]


def summarize_text(text: str, max_length: int = 240) -> str:
    compact = normalize_whitespace(text)
    if len(compact) <= max_length:
        return compact
    return compact[: max_length - 1].rstrip() + "…"


def build_search_text(metadata: dict[str, Any], chunk_text: str) -> str:
    retrieval = metadata.get("retrieval", {}) if isinstance(metadata.get("retrieval"), dict) else {}
    scope = metadata.get("scope", {}) if isinstance(metadata.get("scope"), dict) else {}
    parts = [
        str(metadata.get("title", "")).strip(),
        str(retrieval.get("synopsis", "")).strip(),
        " ".join(str(item).strip() for item in metadata.get("aliases", []) if str(item).strip()),
        " ".join(str(item).strip() for item in metadata.get("tags", []) if str(item).strip()),
        " ".join(
            str(item).strip()
            for item in [
                scope.get("service", ""),
                scope.get("plugin", ""),
                scope.get("feature", ""),
                *(scope.get("environments", []) or []),
            ]
            if str(item).strip()
        ),
        " ".join(str(item).strip() for item in retrieval.get("hints", []) if str(item).strip()),
        " ".join(str(item).strip() for item in retrieval.get("commands", []) if str(item).strip()),
        chunk_text,
    ]
    return "\n".join(part for part in parts if part)


def build_card(metadata: dict[str, Any], chunks: list[ChunkRecord]) -> dict[str, Any]:
    title = str(metadata["title"])
    retrieval = metadata.get("retrieval", {}) if isinstance(metadata.get("retrieval"), dict) else {}
    purpose = summarize_text(str(retrieval.get("synopsis", "")).strip() or (chunks[0].text if chunks else title))
    when_to_use = summarize_text(" ".join(chunk.text for chunk in chunks[:2]))
    scope_bits = [
        str(metadata.get("scope", {}).get("service", "")).strip(),
        str(metadata.get("scope", {}).get("plugin", "")).strip(),
        str(metadata.get("scope", {}).get("feature", "")).strip(),
    ]
    key_scope = ", ".join(bit for bit in scope_bits if bit) or "unspecified"
    key_tokens = [title, metadata.get("doc_id", ""), *scope_bits]
    return {
        "title": title,
        "purpose": purpose,
        "when_to_use": when_to_use,
        "key_scope": key_scope,
        "key_tokens": [token for token in key_tokens if token],
        "lifecycle_state": metadata.get("lifecycle_state", ""),
        "last_validated_at": metadata.get("validation", {}).get("last_validated_at", ""),
        "related_docs": [],
    }


def summarize_sections(chunks: list[ChunkRecord]) -> list[tuple[str, str]]:
    summaries: list[tuple[str, str]] = []
    for chunk in chunks:
        summary = summarize_text(chunk.text)
        summaries.append((chunk.section_path, summary))
    return summaries


def make_chunk_id(doc_id: str, section_path: str, ordinal: int, text: str) -> str:
    seed = f"{doc_id}|{section_path}|{ordinal}|{sha256_text(text)}"
    return f"chk_{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16]}"


def resolve_target_path(runbooks_root: Path, metadata: dict[str, Any], source_path: Path | None = None) -> Path:
    doc_type = str(metadata["type"])
    folder = {
        "incident_runbook": "incidents",
        "feature_runbook": "services",
        "plugin_runbook": "plugins",
        "ops_sop": "infrastructure",
        "troubleshooting_note": "incidents",
        "change_record": "infrastructure",
        "migration_guide": "infrastructure",
        "reference_card": "templates",
    }.get(doc_type, "services")
    title_slug = slugify(str(metadata["title"]))
    if source_path is not None:
        expected_prefix = f"{doc_type}__"
        if source_path.name.startswith(expected_prefix):
            return runbooks_root / folder / source_path.name

        stem = slugify(source_path.stem)
        if stem and stem != "runbook":
            doc_prefix = slugify(doc_type)
            if stem.startswith(f"{doc_prefix}-"):
                stem = stem[len(doc_prefix) + 1 :]
            title_slug = stem
    scope = metadata.get("scope", {}) if isinstance(metadata.get("scope"), dict) else {}
    filename_parts = [doc_type]
    service_slug = slugify(str(scope.get("service", "")).strip())
    plugin_slug = slugify(str(scope.get("plugin", "")).strip())
    feature_slug = slugify(str(scope.get("feature", "")).strip())
    envs = [slugify(str(env).strip()) for env in (scope.get("environments", []) or []) if str(env).strip()]
    if service_slug:
        filename_parts.append(f"svc-{service_slug}")
    if plugin_slug and plugin_slug != service_slug:
        filename_parts.append(f"plg-{plugin_slug}")
    if feature_slug:
        filename_parts.append(f"feat-{feature_slug}")
    if envs:
        filename_parts.append(f"env-{'-'.join(envs[:3])}")
    filename_parts.append(title_slug)
    filename = "__".join(part for part in filename_parts if part) + ".md"
    return runbooks_root / folder / filename


def write_runbook_file(path: Path, metadata: dict[str, Any], body: str) -> None:
    ensure_dir(path.parent)
    path.write_text(dump_frontmatter(metadata) + body.strip() + "\n", encoding="utf-8")


def upsert_document(
    conn: sqlite3.Connection,
    *,
    metadata: dict[str, Any],
    source_path: str,
    canonical_path: str,
    checksum: str,
) -> None:
    now = now_iso()
    conn.execute(
        """
        INSERT INTO documents (
            doc_id, title, type, lifecycle_state, owners_json, tags_json, aliases_json,
            service, feature, plugin, environments_json,
            validation_last_validated_at, validation_review_interval_days,
            provenance_json, synopsis, retrieval_hints_json, not_for_json, commands_json,
            source_path, source_ref, canonical_path,
            content_checksum, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
            title=excluded.title,
            type=excluded.type,
            lifecycle_state=excluded.lifecycle_state,
            owners_json=excluded.owners_json,
            tags_json=excluded.tags_json,
            aliases_json=excluded.aliases_json,
            service=excluded.service,
            feature=excluded.feature,
            plugin=excluded.plugin,
            environments_json=excluded.environments_json,
            validation_last_validated_at=excluded.validation_last_validated_at,
            validation_review_interval_days=excluded.validation_review_interval_days,
            provenance_json=excluded.provenance_json,
            synopsis=excluded.synopsis,
            retrieval_hints_json=excluded.retrieval_hints_json,
            not_for_json=excluded.not_for_json,
            commands_json=excluded.commands_json,
            source_path=excluded.source_path,
            source_ref=excluded.source_ref,
            canonical_path=excluded.canonical_path,
            content_checksum=excluded.content_checksum,
            updated_at=excluded.updated_at
        """,
        (
            metadata["doc_id"],
            metadata["title"],
            metadata["type"],
            metadata["lifecycle_state"],
            json.dumps(metadata.get("owners", {}), sort_keys=True),
            json.dumps(metadata.get("tags", []), sort_keys=True),
            json.dumps(metadata.get("aliases", []), sort_keys=True),
            metadata.get("scope", {}).get("service", ""),
            metadata.get("scope", {}).get("feature", ""),
            metadata.get("scope", {}).get("plugin", ""),
            json.dumps(metadata.get("scope", {}).get("environments", []), sort_keys=True),
            metadata.get("validation", {}).get("last_validated_at", ""),
            int(metadata.get("validation", {}).get("review_interval_days", 30)),
            json.dumps(metadata.get("provenance", {}), sort_keys=True),
            metadata.get("retrieval", {}).get("synopsis", ""),
            json.dumps(metadata.get("retrieval", {}).get("hints", []), sort_keys=True),
            json.dumps(metadata.get("retrieval", {}).get("not_for", []), sort_keys=True),
            json.dumps(metadata.get("retrieval", {}).get("commands", []), sort_keys=True),
            source_path,
            metadata.get("provenance", {}).get("source_ref", ""),
            canonical_path,
            checksum,
            now,
            now,
        ),
    )


def upsert_aliases(conn: sqlite3.Connection, metadata: dict[str, Any], source_path: str | None = None) -> None:
    now = now_iso()
    conn.execute("DELETE FROM document_aliases WHERE doc_id = ?", (metadata["doc_id"],))
    for alias in alias_candidates(metadata, source_path):
        conn.execute(
            """
            INSERT INTO document_aliases(alias, doc_id, kind, created_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(alias) DO UPDATE SET doc_id=excluded.doc_id, kind=excluded.kind
            """,
            (alias, metadata["doc_id"], "generated", now),
        )


def replace_chunks(
    conn: sqlite3.Connection,
    metadata: dict[str, Any],
    chunks: list[ChunkRecord],
    *,
    title: str,
) -> None:
    chunk_rows = conn.execute("SELECT id, chunk_id FROM chunks WHERE doc_id = ?", (metadata["doc_id"],)).fetchall()
    for row in chunk_rows:
        conn.execute("DELETE FROM chunk_fts WHERE rowid = ?", (row["id"],))
    conn.execute("DELETE FROM chunks WHERE doc_id = ?", (metadata["doc_id"],))
    conn.execute("DELETE FROM chunk_embeddings WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks)")
    for chunk in chunks:
        now = now_iso()
        cursor = conn.execute(
            """
            INSERT INTO chunks(chunk_id, doc_id, section_path, ordinal, text, token_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chunk.chunk_id,
                chunk.doc_id,
                chunk.section_path,
                chunk.ordinal,
                chunk.text,
                chunk.token_count,
                now,
                now,
            ),
        )
        conn.execute(
            "INSERT INTO chunk_fts(rowid, chunk_id, doc_id, title, section_path, text) VALUES (?, ?, ?, ?, ?, ?)",
            (
                cursor.lastrowid,
                chunk.chunk_id,
                chunk.doc_id,
                title,
                chunk.section_path,
                build_search_text(metadata, chunk.text),
            ),
        )


def replace_cards_and_summaries(conn: sqlite3.Connection, metadata: dict[str, Any], chunks: list[ChunkRecord]) -> None:
    now = now_iso()
    card = build_card(metadata, chunks)
    conn.execute("DELETE FROM cards WHERE doc_id = ?", (metadata["doc_id"],))
    conn.execute(
        """
        INSERT INTO cards(
            doc_id, title, purpose, when_to_use, key_scope, key_tokens_json,
            lifecycle_state, last_validated_at, related_docs_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            metadata["doc_id"],
            card["title"],
            card["purpose"],
            card["when_to_use"],
            card["key_scope"],
            json.dumps(card["key_tokens"], sort_keys=True),
            card["lifecycle_state"],
            card["last_validated_at"],
            json.dumps(card["related_docs"], sort_keys=True),
            now,
        ),
    )
    conn.execute("DELETE FROM section_summaries WHERE doc_id = ?", (metadata["doc_id"],))
    for section_path, summary in summarize_sections(chunks):
        summary_seed = f"{metadata['doc_id']}|{section_path}"
        summary_id = f"sum_{hashlib.sha256(summary_seed.encode('utf-8')).hexdigest()[:16]}"
        conn.execute(
            """
            INSERT INTO section_summaries(summary_id, doc_id, section_path, summary_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (summary_id, metadata["doc_id"], section_path, summary, now, now),
        )


def embed_and_store(
    conn: sqlite3.Connection,
    chunks: list[ChunkRecord],
    *,
    model_name: str | None,
) -> None:
    if not model_name:
        return
    backend = EmbeddingBackend.load(model_name)
    if not backend.available:
        return
    vectors = backend.encode(chunk.text for chunk in chunks)
    if not vectors:
        return
    now = now_iso()
    for chunk, vector in zip(chunks, vectors):
        conn.execute(
            """
            INSERT INTO chunk_embeddings(chunk_id, model_name, vector_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(chunk_id) DO UPDATE SET
                model_name=excluded.model_name,
                vector_json=excluded.vector_json,
                updated_at=excluded.updated_at
            """,
            (chunk.chunk_id, model_name, json.dumps(vector), now),
        )


def index_markdown_file(
    conn: sqlite3.Connection,
    path: Path,
    *,
    runbooks_root: Path,
    embedding_model: str | None = None,
    max_chunk_chars: int = 1200,
) -> dict[str, Any]:
    parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
    metadata = parsed.metadata or {}
    if not metadata:
        metadata = build_default_frontmatter(
            title=path.stem.replace("-", " ").replace("_", " ").title(),
            doc_type=guess_type_from_path(path),
            provenance_source_ref=str(path),
            lifecycle_state="review",
        )
    else:
        metadata = validate_frontmatter(metadata)
        if not metadata.get("provenance", {}).get("source_ref"):
            metadata["provenance"]["source_ref"] = str(path)
    canonical_path = resolve_target_path(runbooks_root, metadata, path)
    checksum = sha256_text(parsed.body + json.dumps(metadata, sort_keys=True))
    upsert_document(conn, metadata=metadata, source_path=str(path), canonical_path=str(canonical_path), checksum=checksum)
    upsert_aliases(conn, metadata, str(path))
    chunk_specs = chunk_markdown(parsed.body, max_chars=max_chunk_chars)
    chunks: list[ChunkRecord] = []
    for ordinal, (section_path, chunk_text) in enumerate(chunk_specs):
        chunk_id = make_chunk_id(metadata["doc_id"], section_path, ordinal, chunk_text)
        chunks.append(
            ChunkRecord(
                chunk_id=chunk_id,
                doc_id=metadata["doc_id"],
                section_path=section_path,
                ordinal=ordinal,
                text=chunk_text,
                token_count=len(chunk_text.split()),
            )
        )
    replace_chunks(conn, metadata, chunks, title=metadata["title"])
    replace_cards_and_summaries(conn, metadata, chunks)
    embed_and_store(conn, chunks, model_name=embedding_model)
    return metadata


def index_roots(
    conn: sqlite3.Connection,
    roots: Iterable[Path],
    *,
    runbooks_root: Path,
    embedding_model: str | None = None,
    max_chunk_chars: int = 1200,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for path in iter_markdown_files(roots):
        results.append(
            index_markdown_file(
                conn,
                path,
                runbooks_root=runbooks_root,
                embedding_model=embedding_model,
                max_chunk_chars=max_chunk_chars,
            )
        )
    conn.commit()
    return results


def compute_duplicate_candidates(conn: sqlite3.Connection, threshold: float = 0.9) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT doc_id, title, canonical_path, content_checksum FROM documents").fetchall()
    candidates: list[dict[str, Any]] = []
    for left_index, left in enumerate(rows):
        for right in rows[left_index + 1 :]:
            if left["content_checksum"] == right["content_checksum"]:
                candidates.append(
                    {
                        "left_doc_id": left["doc_id"],
                        "right_doc_id": right["doc_id"],
                        "similarity": 1.0,
                        "reason": "identical checksum",
                    }
                )
                continue
            left_text = str(left["title"]).lower()
            right_text = str(right["title"]).lower()
            from difflib import SequenceMatcher

            similarity = SequenceMatcher(None, left_text, right_text).ratio()
            if similarity >= threshold:
                candidates.append(
                    {
                        "left_doc_id": left["doc_id"],
                        "right_doc_id": right["doc_id"],
                        "similarity": round(similarity, 3),
                        "reason": "title similarity",
                    }
                )
    return candidates


def import_legacy_docs(
    conn: sqlite3.Connection,
    source_roots: Iterable[Path],
    *,
    runbooks_root: Path,
    embedding_model: str | None = None,
) -> dict[str, Any]:
    imported: list[dict[str, Any]] = []
    manual_review: list[str] = []
    for path in iter_markdown_files(source_roots):
        parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
        metadata = parsed.metadata or {}
        if not metadata:
            metadata = build_default_frontmatter(
                title=path.stem.replace("-", " ").replace("_", " ").title(),
                doc_type=guess_type_from_path(path),
                lifecycle_state="review",
                provenance_source_ref=str(path),
            )
            manual_review.append(str(path))
        else:
            try:
                metadata = validate_frontmatter(metadata)
            except Exception:
                metadata = build_default_frontmatter(
                    title=metadata.get("title", path.stem),
                    doc_type=str(metadata.get("type") or guess_type_from_path(path)),
                    lifecycle_state="review",
                    provenance_source_ref=str(path),
                )
                manual_review.append(str(path))
            if not metadata.get("provenance", {}).get("source_ref"):
                metadata["provenance"]["source_ref"] = str(path)
        target_path = resolve_target_path(runbooks_root, metadata, path)
        ensure_dir(target_path.parent)
        write_runbook_file(target_path, metadata, parsed.body)
        imported.append({"source": str(path), "target": str(target_path), "doc_id": metadata["doc_id"]})
        index_markdown_file(
            conn,
            target_path,
            runbooks_root=runbooks_root,
            embedding_model=embedding_model,
        )
    conn.commit()
    duplicates = compute_duplicate_candidates(conn)
    return {
        "total_docs_found": len(imported),
        "docs_imported": len(imported),
        "docs_needing_manual_review": manual_review,
        "duplicate_candidates": duplicates,
    }
