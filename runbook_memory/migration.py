from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Iterable

from .frontmatter import build_default_frontmatter, parse_frontmatter, validate_frontmatter
from .indexer import index_markdown_file, resolve_target_path, write_runbook_file
from .schema import ensure_schema
from .utils import ensure_dir, iter_markdown_files, now_iso, normalize_whitespace, sha256_text, slugify


def classify_document(path: Path, metadata: dict[str, Any]) -> str:
    doc_type = str(metadata.get("type", "")).strip()
    if doc_type:
        return doc_type
    stem = path.stem.lower()
    if "plugin" in stem:
        return "plugin_runbook"
    if "incident" in stem or "runbook" in stem:
        return "incident_runbook"
    if "change" in stem or "migration" in stem:
        return "change_record"
    if "sop" in stem or "ops" in stem:
        return "ops_sop"
    return "troubleshooting_note"


def inventory_docs(source_roots: Iterable[Path]) -> list[Path]:
    docs: list[Path] = []
    for path in iter_markdown_files(source_roots):
        docs.append(path)
    return docs


def import_docs(
    conn,
    *,
    source_roots: Iterable[Path],
    runbooks_root: Path,
    embedding_model: str | None = None,
) -> dict[str, Any]:
    imported: list[dict[str, Any]] = []
    manual_review: list[str] = []
    duplicate_clusters: list[dict[str, Any]] = []
    for path in inventory_docs(source_roots):
        parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
        metadata = parsed.metadata or {}
        if metadata:
            try:
                metadata = validate_frontmatter(metadata)
            except Exception:
                metadata = {}
        if not metadata:
            metadata = build_default_frontmatter(
                title=path.stem.replace("-", " ").replace("_", " ").title(),
                doc_type=classify_document(path, {}),
                lifecycle_state="review",
                provenance_source_ref=str(path),
            )
            manual_review.append(str(path))
        if not metadata.get("provenance", {}).get("source_ref"):
            metadata["provenance"]["source_ref"] = str(path)
        if not metadata.get("provenance", {}).get("source_type"):
            metadata["provenance"]["source_type"] = "file"
        target = resolve_target_path(runbooks_root, metadata, path)
        ensure_dir(target.parent)
        write_runbook_file(target, metadata, parsed.body)
        index_markdown_file(
            conn,
            target,
            runbooks_root=runbooks_root,
            embedding_model=embedding_model,
        )
        imported.append({"source": str(path), "target": str(target), "doc_id": metadata["doc_id"]})
    conn.commit()
    duplicate_clusters = scan_duplicate_candidates(conn)
    return {
        "total_docs_found": len(imported),
        "docs_imported": len(imported),
        "docs_needing_manual_review": manual_review,
        "duplicate_clusters": duplicate_clusters,
        "stale_docs": scan_stale_docs(conn),
        "missing_metadata_counts": missing_metadata_counts(conn),
    }


def scan_duplicate_candidates(conn, threshold: float = 0.9) -> list[dict[str, Any]]:
    from difflib import SequenceMatcher

    rows = conn.execute("SELECT doc_id, title, content_checksum FROM documents ORDER BY title").fetchall()
    clusters: list[dict[str, Any]] = []
    for idx, left in enumerate(rows):
        for right in rows[idx + 1 :]:
            if left["content_checksum"] == right["content_checksum"]:
                clusters.append(
                    {
                        "left_doc_id": left["doc_id"],
                        "right_doc_id": right["doc_id"],
                        "similarity": 1.0,
                        "reason": "identical checksum",
                    }
                )
                continue
            similarity = SequenceMatcher(None, left["title"].lower(), right["title"].lower()).ratio()
            if similarity >= threshold:
                clusters.append(
                    {
                        "left_doc_id": left["doc_id"],
                        "right_doc_id": right["doc_id"],
                        "similarity": round(similarity, 3),
                        "reason": "title similarity",
                    }
                )
    return clusters


def scan_stale_docs(conn) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT doc_id, title, lifecycle_state, validation_last_validated_at, validation_review_interval_days FROM documents"
    ).fetchall()
    from datetime import date

    stale: list[dict[str, Any]] = []
    today = date.today()
    for row in rows:
        last_validated = str(row["validation_last_validated_at"] or "").strip()
        if not last_validated:
            stale.append(
                {
                    "doc_id": row["doc_id"],
                    "title": row["title"],
                    "reason": "missing validation date",
                }
            )
            continue
        try:
            validated = date.fromisoformat(last_validated[:10])
            review_days = int(row["validation_review_interval_days"] or 30)
            if (today - validated).days > review_days:
                stale.append(
                    {
                        "doc_id": row["doc_id"],
                        "title": row["title"],
                        "reason": "validation interval exceeded",
                    }
                )
        except Exception:
            stale.append(
                {
                    "doc_id": row["doc_id"],
                    "title": row["title"],
                    "reason": "invalid validation date",
                }
            )
    return stale


def missing_metadata_counts(conn) -> dict[str, int]:
    rows = conn.execute("SELECT * FROM documents").fetchall()
    counts = {"service": 0, "plugin": 0, "feature": 0, "owners": 0, "validation": 0}
    for row in rows:
        if not str(row["service"] or "").strip():
            counts["service"] += 1
        if not str(row["plugin"] or "").strip():
            counts["plugin"] += 1
        if not str(row["feature"] or "").strip():
            counts["feature"] += 1
        if not row["owners_json"]:
            counts["owners"] += 1
        if not str(row["validation_last_validated_at"] or "").strip():
            counts["validation"] += 1
    return counts


def _prepare_changed_doc_metadata(path: Path, raw_metadata: dict[str, Any]) -> dict[str, Any]:
    metadata = raw_metadata or {}
    if metadata:
        try:
            metadata = validate_frontmatter(metadata)
        except Exception:
            metadata = dict(metadata)
    if not metadata:
        metadata = build_default_frontmatter(
            title=path.stem,
            doc_type=classify_document(path, {}),
            lifecycle_state="review",
            provenance_source_ref=str(path),
        )
    provenance = metadata.get("provenance")
    if isinstance(provenance, dict) and not str(provenance.get("source_ref", "")).strip():
        provenance["source_ref"] = str(path)
    return metadata


def update_changed_docs(
    conn,
    *,
    roots: Iterable[Path],
    runbooks_root: Path,
    embedding_model: str | None = None,
) -> list[str]:
    changed: list[str] = []
    for path in iter_markdown_files(roots):
        parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
        metadata = _prepare_changed_doc_metadata(path, parsed.metadata or {})
        canonical_path = resolve_target_path(runbooks_root, metadata, path)
        content_checksum = sha256_text(parsed.body + json.dumps(metadata, sort_keys=True))
        row = conn.execute(
            "SELECT source_path, canonical_path, content_checksum FROM documents WHERE doc_id = ?",
            (metadata["doc_id"],),
        ).fetchone()
        if (
            not row
            or row["content_checksum"] != content_checksum
            or str(row["source_path"] or "") != str(path)
            or str(row["canonical_path"] or "") != str(canonical_path)
        ):
            index_markdown_file(
                conn,
                path,
                runbooks_root=runbooks_root,
                embedding_model=embedding_model,
            )
            changed.append(str(path))
    conn.commit()
    return changed
