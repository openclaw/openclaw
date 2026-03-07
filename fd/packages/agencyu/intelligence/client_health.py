from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.intelligence.client_health")


def compute_health_score(
    *,
    revenue_score: int = 0,
    engagement_score: int = 0,
    responsiveness_score: int = 0,
    overdue_invoices: int = 0,
) -> int:
    """Compute composite client health score (0-100).

    Weights:
    - Revenue consistency: 30%
    - Engagement (task volume + meetings): 35%
    - Responsiveness (feedback time): 20%
    - Payment punctuality: 15%
    """
    payment_score = max(0, 100 - (overdue_invoices * 50))
    weighted = (
        revenue_score * 0.30
        + engagement_score * 0.35
        + responsiveness_score * 0.20
        + payment_score * 0.15
    )
    return max(0, min(100, int(weighted)))


def compute_churn_risk(
    *,
    days_since_last_meeting: int | None = None,
    days_since_last_task: int | None = None,
    overdue_invoices: int = 0,
    engagement_score: int = 50,
) -> tuple[str, int]:
    """Compute churn risk level and score.

    Returns (risk_level, churn_score).

    Signals:
    - Last meeting > 30 days: +30
    - No tasks in 14+ days: +25
    - Overdue invoice: +25
    - Low engagement (< 30): +20
    """
    score = 0

    if days_since_last_meeting is not None and days_since_last_meeting > 30:
        score += 30
    if days_since_last_task is not None and days_since_last_task > 14:
        score += 25
    if overdue_invoices > 0:
        score += 25
    if engagement_score < 30:
        score += 20

    if score >= 60:
        level = "high"
    elif score >= 30:
        level = "medium"
    else:
        level = "low"

    return level, score


def upsert_client_health(
    conn: sqlite3.Connection,
    *,
    client_id: str,
    display_name: str,
    health_score: int,
    churn_risk: str,
    churn_score: int,
    revenue_score: int = 0,
    engagement_score: int = 0,
    responsiveness_score: int = 0,
    last_meeting_ts: str | None = None,
    last_task_ts: str | None = None,
    overdue_invoices: int = 0,
    active_tasks: int = 0,
    notes: str | None = None,
) -> None:
    """Upsert a client health score record."""
    now = utc_now_iso()
    conn.execute(
        """INSERT INTO client_health_scores
           (client_id, display_name, health_score, churn_risk, churn_score,
            revenue_score, engagement_score, responsiveness_score,
            last_meeting_ts, last_task_ts, overdue_invoices, active_tasks,
            notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_id) DO UPDATE SET
             display_name=excluded.display_name,
             health_score=excluded.health_score,
             churn_risk=excluded.churn_risk,
             churn_score=excluded.churn_score,
             revenue_score=excluded.revenue_score,
             engagement_score=excluded.engagement_score,
             responsiveness_score=excluded.responsiveness_score,
             last_meeting_ts=COALESCE(excluded.last_meeting_ts, last_meeting_ts),
             last_task_ts=COALESCE(excluded.last_task_ts, last_task_ts),
             overdue_invoices=excluded.overdue_invoices,
             active_tasks=excluded.active_tasks,
             notes=excluded.notes,
             updated_at=excluded.updated_at""",
        (
            client_id, display_name, health_score, churn_risk, churn_score,
            revenue_score, engagement_score, responsiveness_score,
            last_meeting_ts, last_task_ts, overdue_invoices, active_tasks,
            notes, now, now,
        ),
    )
    conn.commit()
    log.info("client_health_upserted", extra={
        "client_id": client_id, "health_score": health_score, "churn_risk": churn_risk,
    })


def get_churn_risks(
    conn: sqlite3.Connection,
    *,
    min_risk: str = "medium",
) -> list[dict[str, Any]]:
    """Get clients at churn risk, ordered by churn_score DESC.

    Args:
        min_risk: Minimum risk level to include ('low', 'medium', 'high').
    """
    if min_risk == "low":
        risk_levels = ("low", "medium", "high")
    elif min_risk == "medium":
        risk_levels = ("medium", "high")
    else:
        risk_levels = ("high",)

    placeholders = ",".join("?" for _ in risk_levels)
    rows = conn.execute(
        f"SELECT * FROM client_health_scores WHERE churn_risk IN ({placeholders}) ORDER BY churn_score DESC",
        risk_levels,
    ).fetchall()
    return [dict(r) for r in rows]


def get_all_health_scores(
    conn: sqlite3.Connection,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Get all client health scores, ordered by health_score ASC (worst first)."""
    rows = conn.execute(
        "SELECT * FROM client_health_scores ORDER BY health_score ASC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_health_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    """Get aggregate health summary."""
    total = conn.execute("SELECT COUNT(*) FROM client_health_scores").fetchone()[0]
    high_risk = conn.execute(
        "SELECT COUNT(*) FROM client_health_scores WHERE churn_risk='high'"
    ).fetchone()[0]
    medium_risk = conn.execute(
        "SELECT COUNT(*) FROM client_health_scores WHERE churn_risk='medium'"
    ).fetchone()[0]
    low_risk = conn.execute(
        "SELECT COUNT(*) FROM client_health_scores WHERE churn_risk='low'"
    ).fetchone()[0]
    avg_health = conn.execute(
        "SELECT COALESCE(AVG(health_score), 0) FROM client_health_scores"
    ).fetchone()[0]

    return {
        "total_clients": total,
        "avg_health_score": round(avg_health, 1),
        "churn_risk_high": high_risk,
        "churn_risk_medium": medium_risk,
        "churn_risk_low": low_risk,
    }
