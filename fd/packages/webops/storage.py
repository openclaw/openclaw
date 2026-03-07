"""WebOps run persistence — save/query run history and payloads.

Stores each run as a summary row (webops_runs) plus the full payload
(webops_run_payloads) for the status endpoint and history views.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any


def _utc_now() -> str:
    return datetime.now(tz=UTC).isoformat()


def save_webops_run(
    conn: sqlite3.Connection,
    *,
    correlation_id: str,
    payload: dict[str, Any],
) -> int:
    """Persist a run's summary + full payload. Returns the run_id."""
    started = payload.get("timestamp") or _utc_now()
    finished = _utc_now()
    ok = 1 if payload.get("ok") else 0
    summary = {
        "ok": bool(payload.get("ok")),
        "sites_checked": payload.get("sites_checked", 0),
        "failed_count": len(payload.get("failed", [])),
        "warnings": payload.get("warnings", []),
    }
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO webops_runs (correlation_id, started_at_utc, finished_at_utc, ok, summary_json) "
        "VALUES (?,?,?,?,?)",
        (correlation_id, started, finished, ok, json.dumps(summary)),
    )
    run_id = cur.lastrowid
    cur.execute(
        "INSERT INTO webops_run_payloads (run_id, payload_json) VALUES (?,?)",
        (run_id, json.dumps(payload, default=str)),
    )
    conn.commit()
    return int(run_id)  # type: ignore[arg-type]


def get_latest_run(conn: sqlite3.Connection) -> dict[str, Any] | None:
    """Return the most recent run with its full payload, or None."""
    cur = conn.cursor()
    cur.execute(
        "SELECT r.id, r.correlation_id, r.finished_at_utc, r.ok, p.payload_json "
        "FROM webops_runs r "
        "JOIN webops_run_payloads p ON p.run_id = r.id "
        "ORDER BY r.finished_at_utc DESC LIMIT 1"
    )
    row = cur.fetchone()
    if not row:
        return None
    run_id, cid, finished, ok, payload_json = row
    return {
        "run_id": run_id,
        "correlation_id": cid,
        "finished_at_utc": finished,
        "ok": bool(ok),
        "payload": json.loads(payload_json),
    }


def get_run_history(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Return the last N run summaries (no full payloads)."""
    cur = conn.cursor()
    cur.execute(
        "SELECT id, correlation_id, finished_at_utc, ok, summary_json "
        "FROM webops_runs ORDER BY finished_at_utc DESC LIMIT ?",
        (limit,),
    )
    out: list[dict[str, Any]] = []
    for rid, cid, finished, ok, summary_json in cur.fetchall():
        out.append({
            "run_id": rid,
            "correlation_id": cid,
            "finished_at_utc": finished,
            "ok": bool(ok),
            "summary": json.loads(summary_json),
        })
    return out
