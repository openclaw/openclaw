"""WebOps repair plan + fix action persistence.

Stores repair plans (pending approval) and fix action logs (audit trail).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any


def _utc_now() -> str:
    return datetime.now(tz=UTC).isoformat()


# ── Repair plans ────────────────────────────────────────────


def create_repair_plan(
    conn: sqlite3.Connection,
    *,
    site_key: str,
    risk_level: str,
    plan: dict[str, Any],
) -> int:
    """Insert a new pending repair plan. Returns plan_id."""
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO webops_repair_plans "
        "(site_key, status, created_at_utc, created_by, risk_level, plan_json) "
        "VALUES (?,?,?,?,?,?)",
        (site_key, "pending", _utc_now(), "system", risk_level, json.dumps(plan, default=str)),
    )
    conn.commit()
    return int(cur.lastrowid)  # type: ignore[arg-type]


def get_repair_plans(
    conn: sqlite3.Connection,
    *,
    site_key: str | None = None,
    status: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List repair plans, optionally filtered by site_key and/or status."""
    sql = "SELECT id, site_key, status, created_at_utc, risk_level, plan_json, approved_at_utc, applied_at_utc FROM webops_repair_plans"
    conditions: list[str] = []
    params: list[Any] = []
    if site_key:
        conditions.append("site_key = ?")
        params.append(site_key)
    if status:
        conditions.append("status = ?")
        params.append(status)
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY created_at_utc DESC LIMIT ?"
    params.append(limit)

    cur = conn.cursor()
    cur.execute(sql, params)
    out: list[dict[str, Any]] = []
    for row in cur.fetchall():
        plan_id, sk, st, created, risk, plan_json, approved, applied = row
        out.append({
            "plan_id": plan_id,
            "site_key": sk,
            "status": st,
            "created_at_utc": created,
            "risk_level": risk,
            "plan": json.loads(plan_json),
            "approved_at_utc": approved,
            "applied_at_utc": applied,
        })
    return out


def approve_repair_plan(conn: sqlite3.Connection, *, plan_id: int) -> bool:
    """Mark a pending plan as approved. Returns True if updated."""
    cur = conn.cursor()
    cur.execute(
        "UPDATE webops_repair_plans SET status='approved', approved_at_utc=? "
        "WHERE id=? AND status='pending'",
        (_utc_now(), plan_id),
    )
    conn.commit()
    return cur.rowcount > 0


def reject_repair_plan(conn: sqlite3.Connection, *, plan_id: int) -> bool:
    """Mark a pending plan as rejected. Returns True if updated."""
    cur = conn.cursor()
    cur.execute(
        "UPDATE webops_repair_plans SET status='rejected' "
        "WHERE id=? AND status='pending'",
        (plan_id,),
    )
    conn.commit()
    return cur.rowcount > 0


def mark_plan_applied(conn: sqlite3.Connection, *, plan_id: int) -> bool:
    """Mark an approved plan as applied. Returns True if updated."""
    cur = conn.cursor()
    cur.execute(
        "UPDATE webops_repair_plans SET status='applied', applied_at_utc=? "
        "WHERE id=? AND status='approved'",
        (_utc_now(), plan_id),
    )
    conn.commit()
    return cur.rowcount > 0


def get_pending_plan_for_site(
    conn: sqlite3.Connection,
    *,
    site_key: str,
) -> dict[str, Any] | None:
    """Return the most recent pending plan for a site, or None."""
    plans = get_repair_plans(conn, site_key=site_key, status="pending", limit=1)
    return plans[0] if plans else None


# ── Fix action log ──────────────────────────────────────────


def log_fix_action(
    conn: sqlite3.Connection,
    *,
    site_key: str,
    correlation_id: str,
    action_type: str,
    ok: bool,
    details: dict[str, Any],
) -> None:
    """Record a fix action (safe_fix, plan_generated, plan_applied)."""
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO webops_fix_actions "
        "(site_key, correlation_id, created_at_utc, action_type, ok, details_json) "
        "VALUES (?,?,?,?,?,?)",
        (site_key, correlation_id, _utc_now(), action_type, 1 if ok else 0, json.dumps(details, default=str)),
    )
    conn.commit()
