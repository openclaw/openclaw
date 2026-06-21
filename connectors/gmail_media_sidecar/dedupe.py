"""Deterministic dedupe keys for Gmail media records."""

from __future__ import annotations

import hashlib
import json


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def build_dedupe_key(
    *,
    source_account: str,
    gmail_message_id: str,
    gmail_thread_id: str | None,
    rfc822_message_id: str | None,
    internal_date_ms: int | None,
    normalized_text_sha256: str,
) -> str:
    material = {
        "source_account": source_account,
        "gmail_message_id": gmail_message_id,
        "gmail_thread_id": gmail_thread_id,
        "rfc822_message_id": rfc822_message_id,
        "internal_date_ms": internal_date_ms,
        "normalized_text_sha256": normalized_text_sha256,
    }
    digest = hashlib.sha256(canonical_json_bytes(material)).hexdigest()
    return f"gmail:v0:{digest}"
