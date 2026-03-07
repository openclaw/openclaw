"""Expansion Engine — client retention + upsell + cross-sell triggers.

Drives MRR compounding via:
  - Referral engine triggers
  - Expansion upsell detection
  - Client LTV multiplier tracking
  - CUTMV → Full Digital graduation

Trigger rules:
  - 90 days active + no upsell → suggest new package
  - CUTMV paid 2+ months → suggest Full Digital
  - Full Digital client runs ads → suggest Performance Creative Pack
  - High engagement + no referral → trigger referral ask
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.expansion_engine")


class TriggerType(StrEnum):
    UPSELL = "upsell"
    CROSS_SELL = "cross_sell"
    REFERRAL = "referral"
    REACTIVATION = "reactivation"
    GRADUATION = "graduation"  # CUTMV → Full Digital


class TriggerPriority(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


@dataclass(frozen=True)
class ExpansionTrigger:
    """A detected expansion opportunity."""

    contact_key: str
    brand: str
    trigger_type: TriggerType
    priority: TriggerPriority
    rule_name: str
    suggested_offer: str
    reason: str
    client_months_active: int
    current_revenue_cents: int


@dataclass
class ExpansionReport:
    """Summary of all detected expansion opportunities."""

    triggers: list[ExpansionTrigger] = field(default_factory=list)
    by_type: dict[str, int] = field(default_factory=dict)
    total_potential_revenue_cents: int = 0
    scan_ts: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "trigger_count": len(self.triggers),
            "by_type": self.by_type,
            "total_potential_revenue_cents": self.total_potential_revenue_cents,
            "scan_ts": self.scan_ts,
            "triggers": [
                {
                    "contact_key": t.contact_key,
                    "brand": t.brand,
                    "type": t.trigger_type,
                    "priority": t.priority,
                    "rule": t.rule_name,
                    "suggested_offer": t.suggested_offer,
                    "reason": t.reason,
                    "months_active": t.client_months_active,
                    "current_revenue_cents": t.current_revenue_cents,
                }
                for t in self.triggers[:50]
            ],
        }


# ── Trigger Rules ──

# Revenue estimates for upsell potential (cents)
_UPSELL_ESTIMATES: dict[str, int] = {
    "major_label_rollout_sim": 700_000,
    "visual_era_pro": 350_000,
    "performance_creative_pack": 200_000,
    "content_engine_monthly": 300_000,
    "cutmv_pro": 2_900,
    "cutmv_teams": 14_900,
}


def scan_expansion_triggers(
    conn: sqlite3.Connection,
    *,
    min_months_for_upsell: int = 3,
    min_months_for_graduation: int = 2,
) -> ExpansionReport:
    """Scan all active clients for expansion triggers.

    Applies rules:
    1. Long-tenure no-upsell: 90+ days active, no secondary purchase
    2. CUTMV → FD graduation: paid 2+ months on CUTMV
    3. Ad-running FD client: has ad spend → suggest creative pack
    4. High-engagement referral: active + engaged, no referral action yet
    """
    report = ExpansionReport(scan_ts=datetime.now(UTC).isoformat())
    triggers: list[ExpansionTrigger] = []

    # Rule 1: Long-tenure clients without upsell
    try:
        rows = conn.execute(
            """SELECT
                la.contact_key,
                la.brand,
                COALESCE(SUM(ra.amount_cents), 0) AS total_revenue,
                CAST(
                    (julianday('now') - julianday(la.first_touch_ts)) / 30 AS INTEGER
                ) AS months_active,
                COUNT(DISTINCT ra.stripe_event_id) AS purchase_count
            FROM lead_attribution la
            LEFT JOIN revenue_attribution ra ON ra.contact_key = la.contact_key
            WHERE la.primary_stage IN ('closed_won', 'checkout_paid')
            GROUP BY la.contact_key
            HAVING months_active >= ? AND purchase_count <= 1""",
            (min_months_for_upsell,),
        ).fetchall()

        for r in rows:
            brand = r["brand"]
            offer = "major_label_rollout_sim" if brand == "fulldigital" else "cutmv_teams"
            triggers.append(ExpansionTrigger(
                contact_key=r["contact_key"],
                brand=brand,
                trigger_type=TriggerType.UPSELL,
                priority=TriggerPriority.MEDIUM,
                rule_name="long_tenure_no_upsell",
                suggested_offer=offer,
                reason=f"{r['months_active']}mo active, only {r['purchase_count']} purchase(s)",
                client_months_active=int(r["months_active"]),
                current_revenue_cents=int(r["total_revenue"]),
            ))
    except Exception:
        log.debug("expansion_rule1_error", exc_info=True)

    # Rule 2: CUTMV → Full Digital graduation
    try:
        cutoff = (datetime.now(UTC) - timedelta(days=min_months_for_graduation * 30)).isoformat()
        rows = conn.execute(
            """SELECT
                la.contact_key,
                COALESCE(SUM(ra.amount_cents), 0) AS total_revenue,
                CAST(
                    (julianday('now') - julianday(la.first_touch_ts)) / 30 AS INTEGER
                ) AS months_active,
                COUNT(DISTINCT ra.stripe_event_id) AS payments
            FROM lead_attribution la
            LEFT JOIN revenue_attribution ra ON ra.contact_key = la.contact_key
            WHERE la.brand = 'cutmv'
                AND la.primary_stage IN ('closed_won', 'checkout_paid')
                AND la.first_touch_ts <= ?
            GROUP BY la.contact_key
            HAVING payments >= ?""",
            (cutoff, min_months_for_graduation),
        ).fetchall()

        for r in rows:
            triggers.append(ExpansionTrigger(
                contact_key=r["contact_key"],
                brand="cutmv",
                trigger_type=TriggerType.GRADUATION,
                priority=TriggerPriority.HIGH,
                rule_name="cutmv_to_fulldigital",
                suggested_offer="visual_era_pro",
                reason=f"CUTMV paid {r['payments']}x over {r['months_active']}mo — ready for FD",
                client_months_active=int(r["months_active"]),
                current_revenue_cents=int(r["total_revenue"]),
            ))
    except Exception:
        log.debug("expansion_rule2_error", exc_info=True)

    # Rule 3: FD client with ad spend → suggest creative pack
    try:
        rows = conn.execute(
            """SELECT
                la.contact_key,
                la.brand,
                COALESCE(SUM(ra.amount_cents), 0) AS total_revenue,
                CAST(
                    (julianday('now') - julianday(la.first_touch_ts)) / 30 AS INTEGER
                ) AS months_active
            FROM lead_attribution la
            LEFT JOIN revenue_attribution ra ON ra.contact_key = la.contact_key
            WHERE la.brand = 'fulldigital'
                AND la.primary_stage IN ('closed_won', 'checkout_paid')
                AND EXISTS (
                    SELECT 1 FROM attribution_events ae
                    WHERE ae.chain_id = la.chain_id
                    AND json_extract(ae.payload_json, '$.has_ad_spend') = 1
                )
            GROUP BY la.contact_key""",
        ).fetchall()

        for r in rows:
            triggers.append(ExpansionTrigger(
                contact_key=r["contact_key"],
                brand="fulldigital",
                trigger_type=TriggerType.UPSELL,
                priority=TriggerPriority.MEDIUM,
                rule_name="ad_running_suggest_creative",
                suggested_offer="performance_creative_pack",
                reason="Client running ads — suggest Performance Creative Pack",
                client_months_active=int(r["months_active"] or 0),
                current_revenue_cents=int(r["total_revenue"]),
            ))
    except Exception:
        log.debug("expansion_rule3_error", exc_info=True)

    # Rule 4: High-engagement referral trigger
    try:
        rows = conn.execute(
            """SELECT
                la.contact_key,
                la.brand,
                COALESCE(SUM(ra.amount_cents), 0) AS total_revenue,
                CAST(
                    (julianday('now') - julianday(la.first_touch_ts)) / 30 AS INTEGER
                ) AS months_active,
                (SELECT COUNT(*) FROM attribution_events ae2
                 WHERE ae2.chain_id = la.chain_id) AS touch_count
            FROM lead_attribution la
            LEFT JOIN revenue_attribution ra ON ra.contact_key = la.contact_key
            WHERE la.primary_stage IN ('closed_won', 'checkout_paid')
            GROUP BY la.contact_key
            HAVING touch_count >= 5 AND months_active >= 2""",
        ).fetchall()

        for r in rows:
            triggers.append(ExpansionTrigger(
                contact_key=r["contact_key"],
                brand=r["brand"],
                trigger_type=TriggerType.REFERRAL,
                priority=TriggerPriority.LOW,
                rule_name="high_engagement_referral_ask",
                suggested_offer="referral_program",
                reason=f"Engaged client ({r['touch_count']} touches, {r['months_active']}mo) — ask for referral",
                client_months_active=int(r["months_active"]),
                current_revenue_cents=int(r["total_revenue"]),
            ))
    except Exception:
        log.debug("expansion_rule4_error", exc_info=True)

    # Compile report
    report.triggers = triggers
    type_counts: dict[str, int] = {}
    total_potential = 0
    for t in triggers:
        type_counts[t.trigger_type] = type_counts.get(t.trigger_type, 0) + 1
        total_potential += _UPSELL_ESTIMATES.get(t.suggested_offer, 0)

    report.by_type = type_counts
    report.total_potential_revenue_cents = total_potential

    log.info("expansion_scan_complete", extra={
        "trigger_count": len(triggers),
        "by_type": type_counts,
    })

    return report
