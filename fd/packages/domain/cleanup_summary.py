from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.domain.trello_cards import upsert_marked_block

BEGIN = settings.MARKER_BEGIN_CLEANUP_SUMMARY
END = settings.MARKER_END_CLEANUP_SUMMARY


def upsert_cleanup_summary_block(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    reason: str,
    correlation_id: str | None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write a canonical cleanup summary block between markers on a card."""
    payload = {
        "type": "cleanup_summary",
        "ts": now_ts(),
        "reason": reason,
        "correlation_id": correlation_id,
        "extra": extra or {},
    }

    upsert_marked_block(
        conn,
        card_id=card_id,
        begin_marker=BEGIN,
        end_marker=END,
        block_body=json.dumps(payload, separators=(",", ":")),
        correlation_id=correlation_id,
    )

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    write_audit(
        conn,
        action="cleanup.summary_block.applied_or_simulated",
        target=card_id,
        payload={"mode": mode},
        correlation_id=correlation_id,
    )
    return {"ok": True, "mode": mode}
