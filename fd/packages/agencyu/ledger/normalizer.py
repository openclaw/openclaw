"""Event normalizer — maps raw source events to canonical ledger stages.

normalize_event() applies normalization rules from the event_normalization_rules
table. Falls through to raw stage name if no rule matches (safe default).

make_idempotency_key() produces a SHA-256 based dedup key so INSERT OR IGNORE
prevents duplicate event ingestion across retries / at-least-once delivery.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.ledger.normalizer")


@dataclass
class NormalizedEvent:
    """Result of normalizing a raw event before ledger insertion."""

    chain_id: str
    stage: str  # original raw stage
    normalized_stage: str  # canonical stage after rule lookup
    source: str  # ghl | stripe | clickfunnels | meta
    ts: str
    payload: dict[str, Any] = field(default_factory=dict)
    idempotency_key: str = ""


def make_idempotency_key(
    *,
    chain_id: str,
    stage: str,
    source: str,
    ts: str,
    payload: dict[str, Any] | None = None,
) -> str:
    """Produce a SHA-256 idempotency key for dedup.

    Key = SHA256(chain_id | source | stage | ts | sorted_payload_json).
    Payload is included to distinguish events that share the same
    chain + stage + timestamp but differ in content (e.g. partial refund
    vs. full refund on the same second).
    """
    payload_str = json.dumps(payload or {}, separators=(",", ":"), sort_keys=True)
    raw = f"{chain_id}|{source}|{stage}|{ts}|{payload_str}"
    return hashlib.sha256(raw.encode()).hexdigest()


def normalize_event(
    conn: sqlite3.Connection,
    *,
    chain_id: str,
    stage: str,
    source: str,
    ts: str,
    payload: dict[str, Any] | None = None,
) -> NormalizedEvent:
    """Normalize a raw event using the event_normalization_rules table.

    Looks up (source, raw_stage) → normalized_stage. If no rule matches,
    normalized_stage = stage (passthrough).

    Args:
        conn: SQLite connection.
        chain_id: Attribution chain ID.
        stage: Raw stage name from the source system.
        source: Source system identifier (ghl, stripe, clickfunnels, meta).
        ts: ISO timestamp.
        payload: Optional event payload dict.

    Returns:
        NormalizedEvent with computed idempotency_key.
    """
    payload = payload or {}

    # Look up normalization rule
    normalized = stage
    try:
        row = conn.execute(
            """SELECT normalized_stage FROM event_normalization_rules
            WHERE source = ? AND raw_stage = ? AND active = 1
            ORDER BY priority DESC LIMIT 1""",
            (source, stage),
        ).fetchone()
        if row:
            normalized = row[0]
    except Exception:
        log.warning(
            "normalization_rule_lookup_failed",
            extra={"source": source, "stage": stage},
            exc_info=True,
        )

    idem_key = make_idempotency_key(
        chain_id=chain_id,
        stage=normalized,
        source=source,
        ts=ts,
        payload=payload,
    )

    return NormalizedEvent(
        chain_id=chain_id,
        stage=stage,
        normalized_stage=normalized,
        source=source,
        ts=ts,
        payload=payload,
        idempotency_key=idem_key,
    )
