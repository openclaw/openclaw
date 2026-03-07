from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any


def _new_run_id() -> str:
    return uuid.uuid4().hex


def _safe_json(s: str | None) -> dict[str, Any]:
    try:
        return json.loads(s) if s else {}
    except Exception:
        return {}


def record_job_run(
    conn: sqlite3.Connection,
    *,
    job_name: str,
    status: str,
    stop_reason: str | None,
    started_ts: str,
    finished_ts: str,
    stats: dict[str, Any],
    correlation_id: str | None,
) -> str:
    run_id = _new_run_id()
    conn.execute(
        """INSERT INTO job_runs
           (id, job_name, status, stop_reason, started_ts, finished_ts, stats_json, correlation_id)
           VALUES (?,?,?,?,?,?,?,?)""",
        (run_id, job_name, status, stop_reason, started_ts, finished_ts, json.dumps(stats or {}), correlation_id),
    )
    conn.commit()
    return run_id


def get_recent_job_runs(conn: sqlite3.Connection, *, limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        """SELECT job_name, status, stop_reason, finished_ts, stats_json
           FROM job_runs
           ORDER BY finished_ts DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [
        {
            "job_name": r[0],
            "status": r[1],
            "stop_reason": r[2],
            "finished_ts": r[3],
            "stats": _safe_json(r[4]),
        }
        for r in rows
    ]


def get_last_success_ts(conn: sqlite3.Connection, *, job_name: str) -> str | None:
    row = conn.execute(
        """SELECT finished_ts
           FROM job_runs
           WHERE job_name=? AND status='success'
           ORDER BY finished_ts DESC
           LIMIT 1""",
        (job_name,),
    ).fetchone()
    return row[0] if row else None
