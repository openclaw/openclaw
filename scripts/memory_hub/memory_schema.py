from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from scripts.memory_hub.types import SourceRevision


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify_summary(summary: str) -> str:
    if "短" in summary and "回复" in summary:
        return "user-prefers-short-replies"
    if "详细" in summary and "回复" in summary:
        return "user-prefers-detailed-replies"
    slug = summary.strip().lower().replace(" ", "-")
    return slug or "memory"


def build_memory_record(event: dict, classification: dict, source_revision: SourceRevision) -> dict:
    payload = event.get("payload", {})
    memory_type = payload.get("memory_type", "feedback")
    summary = payload.get("summary", "")
    return {
        "memory_id": payload.get("memory_id", str(uuid4())),
        "canonical_key": f"{memory_type}:{slugify_summary(summary)}",
        "source_host": event["source_host"],
        "source_file": event["source_file"],
        "source_revision": source_revision.to_dict(),
        "memory_type": memory_type,
        "status": "candidate" if classification.get("bucket") == "long_term_candidate" else "active",
        "summary": summary,
        "content": payload.get("content", ""),
        "why": payload.get("why", ""),
        "how_to_apply": payload.get("how_to_apply", ""),
        "risk_level": classification.get("risk_level", "medium"),
        "stability": classification.get("stability", "ephemeral"),
        "confidence": payload.get("confidence", 0.8),
        "created_at": payload.get("created_at", now_iso()),
        "updated_at": payload.get("updated_at", now_iso()),
    }


def normalize_memory(raw: dict) -> dict:
    return {
        "memory_id": raw["memory_id"],
        "canonical_key": raw["canonical_key"],
        "source_host": raw["source_host"],
        "memory_type": raw["memory_type"],
        "status": raw["status"],
        "summary": raw["summary"],
        "content": raw["content"],
        "risk_level": raw.get("risk_level", "medium"),
        "stability": raw.get("stability", "ephemeral"),
        "confidence": raw.get("confidence", 0.5),
    }
