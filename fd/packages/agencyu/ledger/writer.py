"""Ledger writer — idempotent event insertion via INSERT OR IGNORE.

LedgerWriter.insert_event() writes a NormalizedEvent to attribution_events.
Uses the idempotency_key unique constraint to silently skip duplicates.
"""
from __future__ import annotations

import json
import sqlite3

from packages.agencyu.ledger.normalizer import NormalizedEvent
from packages.common.logging import get_logger

log = get_logger("agencyu.ledger.writer")


class LedgerWriter:
    """Idempotent writer for the attribution ledger."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert_event(self, event: NormalizedEvent) -> bool:
        """Insert a normalized event. Returns True if inserted, False if duplicate.

        Uses INSERT OR IGNORE on the idempotency_key unique index.
        """
        payload_json = json.dumps(
            event.payload, separators=(",", ":"), sort_keys=True
        )
        try:
            cursor = self.conn.execute(
                """INSERT OR IGNORE INTO attribution_events
                (chain_id, ts, stage, source, payload_json,
                 idempotency_key, normalized_stage)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    event.chain_id,
                    event.ts,
                    event.normalized_stage,
                    event.source,
                    payload_json,
                    event.idempotency_key,
                    event.normalized_stage,
                ),
            )
            self.conn.commit()
            inserted = cursor.rowcount > 0
            if inserted:
                log.info(
                    "event_inserted",
                    extra={
                        "chain_id": event.chain_id,
                        "stage": event.normalized_stage,
                        "source": event.source,
                    },
                )
            else:
                log.debug(
                    "event_duplicate_skipped",
                    extra={
                        "chain_id": event.chain_id,
                        "idempotency_key": event.idempotency_key[:16],
                    },
                )
            return inserted
        except Exception:
            log.warning(
                "event_insert_error",
                extra={
                    "chain_id": event.chain_id,
                    "stage": event.normalized_stage,
                },
                exc_info=True,
            )
            return False
