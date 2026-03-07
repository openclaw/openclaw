"""State Pruner — trims ring buffers and old system_state entries.

Hook into:
- Nightly cron
- After every reconcile
- After every system health check
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.services.system_state import SystemKeys, SystemState
from packages.common.logging import get_logger

log = get_logger("agencyu.services.state_pruner")

MAX_STOP_HISTORY = 200


def prune_recent_job_stops(
    conn: sqlite3.Connection,
    max_items: int = MAX_STOP_HISTORY,
) -> dict[str, Any]:
    """Trim the job stops ring buffer to max_items.

    Returns summary of action taken.
    """
    state = SystemState(conn)
    buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON, default={"items": []})
    items = buf.get("items", [])
    original_count = len(items)

    if original_count <= max_items:
        return {"pruned": False, "count": original_count}

    buf["items"] = items[:max_items]
    state.set_json(SystemKeys.RECENT_JOB_STOPS_JSON, buf)

    trimmed = original_count - max_items
    log.info("job_stops_pruned", extra={"trimmed": trimmed, "remaining": max_items})

    return {"pruned": True, "trimmed": trimmed, "remaining": max_items}


def prune_old_audit_logs(
    conn: sqlite3.Connection,
    *,
    keep_days: int = 90,
) -> dict[str, Any]:
    """Delete audit_logs entries older than keep_days.

    Returns count of deleted rows.
    """
    import time

    cutoff_epoch = int(time.time()) - (keep_days * 86400)
    cutoff_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(cutoff_epoch))

    try:
        cursor = conn.execute(
            "DELETE FROM audit_logs WHERE ts < ?", (cutoff_iso,)
        )
        deleted = cursor.rowcount
        conn.commit()
        log.info("audit_logs_pruned", extra={"deleted": deleted, "cutoff": cutoff_iso})
        return {"pruned": True, "deleted": deleted, "cutoff_iso": cutoff_iso}
    except Exception as exc:
        log.error("audit_logs_prune_failed", extra={"error": str(exc)})
        return {"pruned": False, "error": str(exc)}
