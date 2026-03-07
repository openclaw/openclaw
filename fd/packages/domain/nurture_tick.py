"""Execute pending nurture actions (pre-call nurture sends)."""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.cooldown import is_cooldown_active
from packages.common.job_guard import new_guard
from packages.common.job_runs import record_job_run
from packages.common.logging import get_logger
from packages.domain.nurture import cancel_pending_nurture, should_stop_nurture

log = get_logger("nurture_tick")


def run_nurture_tick(
    conn: sqlite3.Connection,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Execute pending NURTURE_SEND scheduled actions whose run_at_iso <= now.

    Respects DRY_RUN, SAFE_MODE, cooldown, and job guard budgets.
    Checks stop rules before each send.
    """
    started_ts = datetime.now(tz=UTC).isoformat()

    # Circuit breaker
    if is_cooldown_active(conn):
        write_audit(
            conn,
            action="nurture_tick.skipped.cooldown_active",
            target="system",
            payload={},
            correlation_id=correlation_id,
        )
        record_job_run(
            conn, job_name="nurture_tick", status="skipped", stop_reason="cooldown_active",
            started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
            stats={}, correlation_id=correlation_id,
        )
        return {"ok": True, "skipped": True, "reason": "cooldown_active"}

    guard = new_guard("nurture_tick")
    now_iso = datetime.now(tz=UTC).isoformat()

    rows = conn.execute(
        """SELECT id, payload_json FROM scheduled_actions
           WHERE action_type='NURTURE_SEND' AND status='pending'
             AND run_at_iso <= ?
           ORDER BY run_at_iso ASC
           LIMIT ?""",
        (now_iso, settings.JOB_BATCH_LIMIT),
    ).fetchall()

    actions: list[dict[str, Any]] = []

    for row in rows:
        stop_reason = guard.should_stop()
        if stop_reason:
            record_job_run(
                conn, job_name="nurture_tick", status="stopped", stop_reason=stop_reason,
                started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
                stats=guard.snapshot(), correlation_id=correlation_id,
            )
            return {"ok": True, "stopped": True, "reason": stop_reason, "actions": actions, "stats": guard.snapshot()}

        try:
            payload = json.loads(row["payload_json"])
        except (json.JSONDecodeError, TypeError):
            guard.mark_error()
            _mark_action_failed(conn, action_id=row["id"])
            actions.append({"id": row["id"], "action": "parse_error"})
            continue

        contact_key = payload.get("contact_key")

        # Check stop rules
        if contact_key:
            stop = should_stop_nurture(conn, contact_key=contact_key)
            if stop:
                cancel_pending_nurture(conn, contact_key=contact_key, reason=stop, correlation_id=correlation_id)
                actions.append({"id": row["id"], "action": "stopped", "reason": stop, "contact_key": contact_key})
                guard.mark_processed()
                continue

        # Execute nurture send (simulated — would trigger GHL workflow enrollment)
        if settings.DRY_RUN or settings.SAFE_MODE:
            actions.append({
                "id": row["id"],
                "action": "would_send_nurture",
                "asset_type": payload.get("asset_type"),
                "contact_key": contact_key,
            })
        else:
            guard.mark_write()
            # In production: enroll contact in GHL workflow here
            # For now, mark as completed
            conn.execute(
                "UPDATE scheduled_actions SET status='completed', updated_ts=? WHERE id=?",
                (datetime.now(tz=UTC).isoformat(), row["id"]),
            )
            conn.commit()
            actions.append({
                "id": row["id"],
                "action": "nurture_sent",
                "asset_type": payload.get("asset_type"),
                "contact_key": contact_key,
            })

        guard.mark_processed()

    record_job_run(
        conn, job_name="nurture_tick", status="success", stop_reason=None,
        started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
        stats=guard.snapshot(), correlation_id=correlation_id,
    )

    return {"ok": True, "actions": actions, "count": len(actions), "stats": guard.snapshot()}


def _mark_action_failed(conn: sqlite3.Connection, *, action_id: int) -> None:
    conn.execute(
        "UPDATE scheduled_actions SET status='failed', updated_ts=? WHERE id=?",
        (datetime.now(tz=UTC).isoformat(), action_id),
    )
    conn.commit()
