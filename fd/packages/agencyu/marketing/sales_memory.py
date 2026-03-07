"""Sales Memory — objection tracking and pattern analysis for VSL evolution.

Records call objections, aggregates patterns, and surfaces insights
for VSL/pricing adjustments. Backed by SQLite sales_objections table.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.sales_memory")

# Common objection categories
OBJECTION_CATEGORIES = {
    "price": "Pricing / budget concern",
    "timing": "Not the right time",
    "trust": "Need more proof / case studies",
    "diy": "Want to do it themselves",
    "competitor": "Considering competitors",
    "spouse": "Need to consult partner/team",
    "unclear_value": "Don't understand the offer",
    "scope": "Scope doesn't match needs",
    "other": "Other",
}


def record_objection(
    conn: sqlite3.Connection,
    *,
    contact_id: str,
    objection_category: str,
    objection_text: str | None = None,
    call_outcome: str | None = None,
    setter_id: str | None = None,
    campaign: str | None = None,
    brand: str | None = None,
    correlation_id: str | None = None,
) -> str:
    """Record a sales objection from a call.

    Returns the objection record ID.
    """
    obj_id = new_id("obj")
    now = utc_now_iso()

    conn.execute(
        """INSERT INTO sales_objections
           (id, contact_id, objection_category, objection_text, call_outcome,
            setter_id, campaign, brand, correlation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (obj_id, contact_id, objection_category, objection_text,
         call_outcome, setter_id, campaign, brand, correlation_id, now),
    )
    conn.commit()

    log.info("objection_recorded", extra={
        "contact_id": contact_id,
        "category": objection_category,
        "outcome": call_outcome,
    })
    return obj_id


def get_objection_frequency(
    conn: sqlite3.Connection,
    *,
    campaign: str | None = None,
    brand: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Get objection frequency breakdown, optionally filtered by campaign/brand."""
    conditions: list[str] = []
    params: list[Any] = []

    if campaign:
        conditions.append("campaign=?")
        params.append(campaign)
    if brand:
        conditions.append("brand=?")
        params.append(brand)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    rows = conn.execute(
        f"""SELECT objection_category, COUNT(*) as count,
                   GROUP_CONCAT(DISTINCT call_outcome) as outcomes
            FROM sales_objections
            {where}
            GROUP BY objection_category
            ORDER BY count DESC
            LIMIT ?""",
        (*params, limit),
    ).fetchall()

    return [dict(r) for r in rows]


def get_recent_objections(
    conn: sqlite3.Connection,
    *,
    limit: int = 50,
    campaign: str | None = None,
) -> list[dict[str, Any]]:
    """Get recent objection records."""
    if campaign:
        rows = conn.execute(
            "SELECT * FROM sales_objections WHERE campaign=? ORDER BY created_at DESC LIMIT ?",
            (campaign, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM sales_objections ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def analyze_objection_patterns(
    conn: sqlite3.Connection,
) -> dict[str, Any]:
    """Analyze objection patterns and surface actionable insights.

    Returns recommendations for VSL, pricing, or process adjustments.
    """
    freq = get_objection_frequency(conn)
    total = sum(r["count"] for r in freq)

    if total == 0:
        return {"total_objections": 0, "insights": [], "recommendations": []}

    insights: list[dict[str, Any]] = []
    recommendations: list[str] = []

    for row in freq:
        category = row["objection_category"]
        count = row["count"]
        pct = round(count / total * 100, 1)
        insights.append({
            "category": category,
            "count": count,
            "pct": pct,
            "label": OBJECTION_CATEGORIES.get(category, category),
        })

        # Generate recommendations based on dominant objections
        if pct >= 30:
            if category == "price":
                recommendations.append("Consider VSL price anchoring adjustment or payment plan emphasis")
            elif category == "trust":
                recommendations.append("Add more case studies and social proof to VSL")
            elif category == "timing":
                recommendations.append("Strengthen urgency messaging in follow-up sequence")
            elif category == "unclear_value":
                recommendations.append("Revise VSL offer stack for clarity")
            elif category == "diy":
                recommendations.append("Add DIY failure statistics to VSL")

    return {
        "total_objections": total,
        "insights": insights,
        "recommendations": recommendations,
    }
