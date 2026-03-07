from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.attribution.engine")


@dataclass
class AttributionUpdate:
    """Extracted attribution data from any event payload."""
    contact_key: str
    utm_source: str | None = None
    utm_medium: str | None = None
    utm_campaign: str | None = None
    utm_content: str | None = None
    utm_term: str | None = None
    manychat_user_id: str | None = None
    ghl_contact_id: str | None = None
    stripe_payment_id: str | None = None
    revenue_cents: int | None = None


class AttributionEngine:
    """End-to-end attribution: UTM → lead → payment → campaign ROAS.

    Stores attribution snapshots and resolves campaign credit.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def extract_from_payload(self, payload: dict[str, Any]) -> AttributionUpdate | None:
        """Extract attribution data from a generic event payload.

        Tries multiple field conventions (manychat, clickfunnels, ghl, stripe).
        """
        # Resolve contact key (first non-empty identifier)
        contact_key = (
            payload.get("ghl_contact_id")
            or payload.get("contact_id")
            or payload.get("manychat_user_id")
            or payload.get("email")
        )
        if not contact_key:
            return None

        # Extract UTMs from flat or nested structure
        utms = payload.get("utm", {}) or {}
        utm_source = payload.get("utm_source") or utms.get("source")
        utm_medium = payload.get("utm_medium") or utms.get("medium")
        utm_campaign = payload.get("utm_campaign") or utms.get("campaign")
        utm_content = payload.get("utm_content") or utms.get("content")
        utm_term = payload.get("utm_term") or utms.get("term")

        return AttributionUpdate(
            contact_key=contact_key,
            utm_source=utm_source,
            utm_medium=utm_medium,
            utm_campaign=utm_campaign,
            utm_content=utm_content,
            utm_term=utm_term,
            manychat_user_id=payload.get("manychat_user_id"),
            ghl_contact_id=payload.get("ghl_contact_id"),
            stripe_payment_id=payload.get("stripe_payment_id") or payload.get("payment_intent_id"),
            revenue_cents=payload.get("revenue_cents") or payload.get("amount"),
        )

    def record_snapshot(self, update: AttributionUpdate) -> str:
        """Upsert an attribution snapshot for the contact."""
        now = utc_now_iso()
        snapshot_id = new_id("attr")

        # Check existing
        existing = self.conn.execute(
            "SELECT * FROM attribution_snapshot WHERE contact_key=? ORDER BY updated_at DESC LIMIT 1",
            (update.contact_key,),
        ).fetchone()

        if existing:
            # Merge: preserve first_touch, update last_touch
            self.conn.execute(
                """UPDATE attribution_snapshot SET
                     utm_source=COALESCE(?, utm_source),
                     utm_medium=COALESCE(?, utm_medium),
                     utm_campaign=COALESCE(?, utm_campaign),
                     utm_content=COALESCE(?, utm_content),
                     utm_term=COALESCE(?, utm_term),
                     last_touch_ts=?,
                     manychat_user_id=COALESCE(?, manychat_user_id),
                     ghl_contact_id=COALESCE(?, ghl_contact_id),
                     stripe_payment_id=COALESCE(?, stripe_payment_id),
                     revenue_cents=COALESCE(?, revenue_cents),
                     updated_at=?
                   WHERE id=?""",
                (
                    update.utm_source, update.utm_medium, update.utm_campaign,
                    update.utm_content, update.utm_term,
                    now,
                    update.manychat_user_id, update.ghl_contact_id,
                    update.stripe_payment_id, update.revenue_cents,
                    now, existing["id"],
                ),
            )
            self.conn.commit()
            log.info("attribution_snapshot_updated", extra={"contact_key": update.contact_key})
            return existing["id"]

        self.conn.execute(
            """INSERT INTO attribution_snapshot
               (id, contact_key, utm_source, utm_medium, utm_campaign,
                utm_content, utm_term, first_touch_ts, last_touch_ts,
                manychat_user_id, ghl_contact_id, stripe_payment_id,
                revenue_cents, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                snapshot_id, update.contact_key,
                update.utm_source, update.utm_medium, update.utm_campaign,
                update.utm_content, update.utm_term,
                now, now,
                update.manychat_user_id, update.ghl_contact_id,
                update.stripe_payment_id, update.revenue_cents,
                now, now,
            ),
        )
        self.conn.commit()
        log.info("attribution_snapshot_created", extra={"contact_key": update.contact_key, "id": snapshot_id})
        return snapshot_id

    def get_snapshot(self, contact_key: str) -> dict[str, Any] | None:
        """Get the latest attribution snapshot for a contact."""
        row = self.conn.execute(
            "SELECT * FROM attribution_snapshot WHERE contact_key=? ORDER BY updated_at DESC LIMIT 1",
            (contact_key,),
        ).fetchone()
        return dict(row) if row else None

    def get_campaign_roas(self, utm_campaign: str) -> dict[str, Any]:
        """Calculate basic ROAS metrics for a campaign."""
        rows = self.conn.execute(
            "SELECT * FROM attribution_snapshot WHERE utm_campaign=?",
            (utm_campaign,),
        ).fetchall()

        total_revenue = sum(r["revenue_cents"] or 0 for r in rows)
        lead_count = len(rows)
        paid_count = sum(1 for r in rows if r["stripe_payment_id"])

        return {
            "utm_campaign": utm_campaign,
            "lead_count": lead_count,
            "paid_count": paid_count,
            "total_revenue_cents": total_revenue,
            "close_rate": round(paid_count / lead_count, 4) if lead_count else 0,
        }
