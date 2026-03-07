from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.intelligence.campaign_integrity")


def refresh_campaign_integrity(
    conn: sqlite3.Connection,
) -> list[dict[str, Any]]:
    """Refresh campaign attribution integrity from attribution_snapshot data.

    Cross-validates:
    - Lead count per campaign
    - Revenue attribution
    - Close rates
    - Flags integrity issues
    """
    campaigns = conn.execute(
        "SELECT DISTINCT utm_campaign FROM attribution_snapshot WHERE utm_campaign IS NOT NULL"
    ).fetchall()

    results: list[dict[str, Any]] = []
    now = utc_now_iso()

    for row in campaigns:
        campaign = row["utm_campaign"]
        snapshots = conn.execute(
            "SELECT * FROM attribution_snapshot WHERE utm_campaign=?",
            (campaign,),
        ).fetchall()

        total_leads = len(snapshots)
        paid_count = sum(1 for s in snapshots if s["stripe_payment_id"])
        total_revenue = sum(s["revenue_cents"] or 0 for s in snapshots)
        close_rate = round(paid_count / total_leads, 4) if total_leads > 0 else 0.0

        # Check for integrity issues
        issues: list[str] = []
        orphaned_revenue = sum(
            1 for s in snapshots
            if s["revenue_cents"] and s["revenue_cents"] > 0 and not s["stripe_payment_id"]
        )
        if orphaned_revenue > 0:
            issues.append(f"orphaned_revenue:{orphaned_revenue}")

        missing_utm_source = sum(1 for s in snapshots if not s["utm_source"])
        if missing_utm_source > 0:
            issues.append(f"missing_utm_source:{missing_utm_source}")

        no_ghl = sum(1 for s in snapshots if not s["ghl_contact_id"])
        if no_ghl > 0:
            issues.append(f"missing_ghl_contact:{no_ghl}")

        integrity_status = "ok" if not issues else "warning"

        # Get ad spend from campaign_integrity if already tracked
        existing = conn.execute(
            "SELECT ad_spend_cents FROM campaign_integrity WHERE utm_campaign=?",
            (campaign,),
        ).fetchone()
        ad_spend = existing["ad_spend_cents"] if existing else 0
        roas = round(total_revenue / ad_spend, 4) if ad_spend > 0 else 0.0

        # Upsert
        conn.execute(
            """INSERT INTO campaign_integrity
               (utm_campaign, source, total_leads, booked_calls, closed_won,
                total_revenue_cents, ad_spend_cents, roas, close_rate,
                integrity_status, issues_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(utm_campaign) DO UPDATE SET
                 total_leads=excluded.total_leads,
                 closed_won=excluded.closed_won,
                 total_revenue_cents=excluded.total_revenue_cents,
                 roas=excluded.roas,
                 close_rate=excluded.close_rate,
                 integrity_status=excluded.integrity_status,
                 issues_json=excluded.issues_json,
                 updated_at=excluded.updated_at""",
            (
                campaign,
                snapshots[0]["utm_source"] if snapshots else None,
                total_leads, 0, paid_count, total_revenue,
                ad_spend, roas, close_rate,
                integrity_status, json.dumps(issues) if issues else None,
                now, now,
            ),
        )

        results.append({
            "utm_campaign": campaign,
            "total_leads": total_leads,
            "closed_won": paid_count,
            "total_revenue_cents": total_revenue,
            "close_rate": close_rate,
            "roas": roas,
            "integrity_status": integrity_status,
            "issues": issues,
        })

    conn.commit()
    log.info("campaign_integrity_refreshed", extra={"campaigns": len(results)})
    return results


def get_campaign_integrity(
    conn: sqlite3.Connection,
    *,
    status_filter: str | None = None,
) -> list[dict[str, Any]]:
    """Get campaign integrity records."""
    if status_filter:
        rows = conn.execute(
            "SELECT * FROM campaign_integrity WHERE integrity_status=? ORDER BY total_revenue_cents DESC",
            (status_filter,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM campaign_integrity ORDER BY total_revenue_cents DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def set_ad_spend(
    conn: sqlite3.Connection,
    *,
    utm_campaign: str,
    ad_spend_cents: int,
) -> None:
    """Set ad spend for a campaign (for ROAS calculation)."""
    now = utc_now_iso()
    conn.execute(
        """INSERT INTO campaign_integrity
           (utm_campaign, source, total_leads, booked_calls, closed_won,
            total_revenue_cents, ad_spend_cents, roas, close_rate,
            integrity_status, created_at, updated_at)
           VALUES (?, NULL, 0, 0, 0, 0, ?, 0.0, 0.0, 'ok', ?, ?)
           ON CONFLICT(utm_campaign) DO UPDATE SET
             ad_spend_cents=excluded.ad_spend_cents,
             updated_at=excluded.updated_at""",
        (utm_campaign, ad_spend_cents, now, now),
    )
    conn.commit()


def get_integrity_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    """Get aggregate campaign integrity summary."""
    total = conn.execute("SELECT COUNT(*) FROM campaign_integrity").fetchone()[0]
    ok_count = conn.execute(
        "SELECT COUNT(*) FROM campaign_integrity WHERE integrity_status='ok'"
    ).fetchone()[0]
    warning_count = conn.execute(
        "SELECT COUNT(*) FROM campaign_integrity WHERE integrity_status='warning'"
    ).fetchone()[0]
    total_revenue = conn.execute(
        "SELECT COALESCE(SUM(total_revenue_cents), 0) FROM campaign_integrity"
    ).fetchone()[0]
    total_spend = conn.execute(
        "SELECT COALESCE(SUM(ad_spend_cents), 0) FROM campaign_integrity"
    ).fetchone()[0]
    overall_roas = round(total_revenue / total_spend, 4) if total_spend > 0 else 0.0

    return {
        "total_campaigns": total,
        "campaigns_ok": ok_count,
        "campaigns_warning": warning_count,
        "total_revenue_cents": total_revenue,
        "total_ad_spend_cents": total_spend,
        "overall_roas": overall_roas,
    }
