"""VSL Optimizer — retention tracking + hook A/B testing for VSL funnels.

Tracks:
  - % watched (watch progress)
  - Drop-off minute
  - CTA click rate
  - Conversion per variant

Then rotates intro hooks to maximize watch-through → booking rate.

Requires VSL view events in attribution_events with payload:
  - vsl_id: identifier for the VSL
  - variant_id: hook variant being tested
  - watch_pct: 0-100 (how much they watched)
  - watch_seconds: total seconds watched
  - cta_clicked: bool
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.vsl_optimizer")


@dataclass(frozen=True)
class VSLVariantStats:
    """Performance stats for a single VSL hook variant."""

    vsl_id: str
    variant_id: str
    views: int
    avg_watch_pct: float
    median_watch_pct: float
    avg_watch_seconds: float
    drop_off_minute: float  # Most common drop-off point
    cta_clicks: int
    cta_click_rate: float
    bookings: int
    booking_rate: float  # bookings / views
    conversions: int
    conversion_rate: float  # conversions / views
    revenue_cents: int


@dataclass
class VSLReport:
    """Aggregate VSL performance report."""

    vsl_id: str
    total_views: int
    variants: list[VSLVariantStats]
    winner: VSLVariantStats | None
    recommendation: str
    generated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "vsl_id": self.vsl_id,
            "total_views": self.total_views,
            "variant_count": len(self.variants),
            "winner": {
                "variant_id": self.winner.variant_id,
                "avg_watch_pct": self.winner.avg_watch_pct,
                "cta_click_rate": self.winner.cta_click_rate,
                "booking_rate": self.winner.booking_rate,
                "conversion_rate": self.winner.conversion_rate,
            } if self.winner else None,
            "recommendation": self.recommendation,
            "variants": [
                {
                    "variant_id": v.variant_id,
                    "views": v.views,
                    "avg_watch_pct": v.avg_watch_pct,
                    "drop_off_minute": v.drop_off_minute,
                    "cta_click_rate": v.cta_click_rate,
                    "booking_rate": v.booking_rate,
                    "conversion_rate": v.conversion_rate,
                    "revenue_cents": v.revenue_cents,
                }
                for v in self.variants
            ],
            "generated_at": self.generated_at,
        }


def get_vsl_variant_stats(
    conn: sqlite3.Connection,
    vsl_id: str,
    *,
    window_days: int = 30,
) -> list[VSLVariantStats]:
    """Get per-variant stats for a VSL from attribution events.

    Expects attribution_events with:
    - stage = 'vsl_view' and payload_json containing vsl_id, variant_id, watch_pct, watch_seconds, cta_clicked
    - Downstream stages: 'call_booked', 'checkout_paid' on same chain
    """
    since = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()

    sql = """
    SELECT
        json_extract(ae.payload_json, '$.variant_id') AS variant_id,
        COUNT(*) AS views,
        AVG(CAST(json_extract(ae.payload_json, '$.watch_pct') AS REAL)) AS avg_watch_pct,
        AVG(CAST(json_extract(ae.payload_json, '$.watch_seconds') AS REAL)) AS avg_watch_sec,
        SUM(CASE WHEN json_extract(ae.payload_json, '$.cta_clicked') = 1 THEN 1 ELSE 0 END) AS cta_clicks,
        -- Downstream: bookings on same chain
        (SELECT COUNT(DISTINCT ae2.chain_id)
         FROM attribution_events ae2
         WHERE ae2.chain_id = ae.chain_id
         AND ae2.stage IN ('call_booked', 'booking_complete')
         AND ae2.ts > ae.ts) AS bookings_sample,
        -- Downstream: conversions on same chain
        (SELECT COUNT(DISTINCT ae3.chain_id)
         FROM attribution_events ae3
         WHERE ae3.chain_id = ae.chain_id
         AND ae3.stage = 'checkout_paid'
         AND ae3.ts > ae.ts) AS conversions_sample,
        COALESCE(
            (SELECT SUM(CAST(json_extract(ae4.payload_json, '$.amount_cents') AS INTEGER))
             FROM attribution_events ae4
             WHERE ae4.chain_id = ae.chain_id
             AND ae4.stage = 'checkout_paid'
             AND ae4.ts > ae.ts), 0
        ) AS revenue_cents_sample
    FROM attribution_events ae
    WHERE json_extract(ae.payload_json, '$.vsl_id') = ?
        AND ae.stage = 'vsl_view'
        AND ae.ts >= ?
    GROUP BY variant_id
    HAVING variant_id IS NOT NULL
    ORDER BY views DESC
    """
    stats: list[VSLVariantStats] = []

    try:
        rows = conn.execute(sql, (vsl_id, since)).fetchall()
    except Exception:
        log.warning("vsl_stats_query_error", exc_info=True)
        return stats

    for r in rows:
        views = int(r["views"] or 0)
        if views == 0:
            continue

        avg_pct = float(r["avg_watch_pct"] or 0)
        avg_sec = float(r["avg_watch_sec"] or 0)
        cta = int(r["cta_clicks"] or 0)
        bookings = int(r["bookings_sample"] or 0)
        conversions = int(r["conversions_sample"] or 0)
        revenue = int(r["revenue_cents_sample"] or 0)

        # Estimate drop-off minute from avg watch seconds
        drop_off = round(avg_sec / 60, 1)

        stats.append(VSLVariantStats(
            vsl_id=vsl_id,
            variant_id=r["variant_id"],
            views=views,
            avg_watch_pct=round(avg_pct, 1),
            median_watch_pct=round(avg_pct, 1),  # Approx (no median in SQLite)
            avg_watch_seconds=round(avg_sec, 1),
            drop_off_minute=drop_off,
            cta_clicks=cta,
            cta_click_rate=round(cta / views, 4),
            bookings=bookings,
            booking_rate=round(bookings / views, 4),
            conversions=conversions,
            conversion_rate=round(conversions / views, 4),
            revenue_cents=revenue,
        ))

    return stats


def analyze_vsl(
    conn: sqlite3.Connection,
    vsl_id: str,
    *,
    window_days: int = 30,
    min_views_for_winner: int = 50,
) -> VSLReport:
    """Full VSL analysis: variant comparison + winner detection + recommendation.

    Scoring: weighted blend of watch_pct (30%), cta_click_rate (30%),
    booking_rate (25%), conversion_rate (15%).
    """
    variants = get_vsl_variant_stats(conn, vsl_id, window_days=window_days)
    total_views = sum(v.views for v in variants)

    winner: VSLVariantStats | None = None
    recommendation = "insufficient_data"

    if variants:
        # Score each variant
        scored: list[tuple[float, VSLVariantStats]] = []
        for v in variants:
            score = (
                (v.avg_watch_pct / 100) * 30
                + v.cta_click_rate * 30
                + v.booking_rate * 25
                + v.conversion_rate * 15
            )
            scored.append((score, v))

        scored.sort(key=lambda x: x[0], reverse=True)
        top_score, top_variant = scored[0]

        if top_variant.views >= min_views_for_winner:
            winner = top_variant

            if len(scored) > 1 and scored[1][0] > 0:
                lift = ((top_score - scored[1][0]) / scored[1][0]) * 100
                recommendation = (
                    f"scale_winner:{top_variant.variant_id} "
                    f"(+{lift:.0f}% over runner-up, "
                    f"watch={top_variant.avg_watch_pct:.0f}%, "
                    f"cta={top_variant.cta_click_rate:.1%})"
                )
            else:
                recommendation = f"scale_winner:{top_variant.variant_id}"

            # Check for drop-off issues
            if top_variant.avg_watch_pct < 40:
                recommendation += " | warning:low_retention_under_40pct"
            if top_variant.drop_off_minute < 2:
                recommendation += " | warning:early_dropoff_under_2min"
        else:
            recommendation = (
                f"need_more_data:top_variant={top_variant.variant_id} "
                f"has {top_variant.views}/{min_views_for_winner} views"
            )

    return VSLReport(
        vsl_id=vsl_id,
        total_views=total_views,
        variants=variants,
        winner=winner,
        recommendation=recommendation,
        generated_at=datetime.now(UTC).isoformat(),
    )


def get_all_vsl_ids(
    conn: sqlite3.Connection,
    *,
    window_days: int = 30,
) -> list[str]:
    """Get all VSL IDs that have received views in the window."""
    since = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
    try:
        rows = conn.execute(
            """SELECT DISTINCT json_extract(payload_json, '$.vsl_id') AS vsl_id
               FROM attribution_events
               WHERE stage = 'vsl_view' AND ts >= ?
               AND json_extract(payload_json, '$.vsl_id') IS NOT NULL""",
            (since,),
        ).fetchall()
        return [r["vsl_id"] for r in rows]
    except Exception:
        return []


def run_vsl_optimization_cycle(
    conn: sqlite3.Connection,
    *,
    window_days: int = 30,
) -> dict[str, Any]:
    """Run optimization across all active VSLs.

    Returns summary with per-VSL reports and recommendations.
    """
    vsl_ids = get_all_vsl_ids(conn, window_days=window_days)
    reports: dict[str, dict[str, Any]] = {}
    winners: list[str] = []
    needs_data: list[str] = []

    for vsl_id in vsl_ids:
        report = analyze_vsl(conn, vsl_id, window_days=window_days)
        reports[vsl_id] = report.to_dict()

        if report.winner:
            winners.append(vsl_id)
        else:
            needs_data.append(vsl_id)

    return {
        "ok": True,
        "vsl_count": len(vsl_ids),
        "winners": winners,
        "needs_data": needs_data,
        "reports": reports,
        "ts": datetime.now(UTC).isoformat(),
    }
