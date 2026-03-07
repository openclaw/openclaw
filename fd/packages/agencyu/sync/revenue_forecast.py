from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.sync.revenue_forecast")


def compute_forecast(
    conn: sqlite3.Connection,
    *,
    forecast_month: str,
    active_mrr: int = 0,
    pipeline_value: int = 0,
    booked_calls: int = 0,
    historical_close_rate: float = 0.0,
    notes: str | None = None,
) -> dict[str, Any]:
    """Compute and store a revenue forecast for a given month.

    Formula:
    - projected_new_revenue = pipeline_value * historical_close_rate
    - total_forecast = active_mrr + projected_new_revenue
    """
    projected_new = int(pipeline_value * historical_close_rate)
    total_forecast = active_mrr + projected_new
    now = utc_now_iso()

    # Upsert
    existing = conn.execute(
        "SELECT id FROM revenue_forecast WHERE forecast_month=?",
        (forecast_month,),
    ).fetchone()

    if existing:
        forecast_id = existing["id"]
        conn.execute(
            """UPDATE revenue_forecast SET
                 active_mrr=?, pipeline_value=?, booked_calls=?,
                 historical_close_rate=?, projected_new_revenue=?,
                 total_forecast=?, notes=?, updated_at=?
               WHERE id=?""",
            (active_mrr, pipeline_value, booked_calls,
             historical_close_rate, projected_new, total_forecast,
             notes, now, forecast_id),
        )
    else:
        forecast_id = new_id("rf")
        conn.execute(
            """INSERT INTO revenue_forecast
               (id, forecast_month, active_mrr, pipeline_value, booked_calls,
                historical_close_rate, projected_new_revenue, total_forecast,
                notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (forecast_id, forecast_month, active_mrr, pipeline_value, booked_calls,
             historical_close_rate, projected_new, total_forecast,
             notes, now, now),
        )
    conn.commit()

    log.info("forecast_computed", extra={
        "month": forecast_month,
        "mrr": active_mrr,
        "pipeline": pipeline_value,
        "projected_new": projected_new,
        "total": total_forecast,
    })

    return {
        "id": forecast_id,
        "forecast_month": forecast_month,
        "active_mrr": active_mrr,
        "pipeline_value": pipeline_value,
        "booked_calls": booked_calls,
        "historical_close_rate": historical_close_rate,
        "projected_new_revenue": projected_new,
        "total_forecast": total_forecast,
    }


def get_forecast(conn: sqlite3.Connection, forecast_month: str) -> dict[str, Any] | None:
    """Get forecast for a specific month."""
    row = conn.execute(
        "SELECT * FROM revenue_forecast WHERE forecast_month=?",
        (forecast_month,),
    ).fetchone()
    return dict(row) if row else None


def get_recent_forecasts(conn: sqlite3.Connection, *, limit: int = 6) -> list[dict[str, Any]]:
    """Get most recent forecasts."""
    rows = conn.execute(
        "SELECT * FROM revenue_forecast ORDER BY forecast_month DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]
