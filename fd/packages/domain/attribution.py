from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("attribution")

# Tag schema: campaign:<name>, source:<type>, status:<stage>, revenue:<tier>
TAG_PREFIX_CAMPAIGN = "campaign:"
TAG_PREFIX_SOURCE = "source:"
TAG_PREFIX_STATUS = "status:"
TAG_PREFIX_REVENUE = "revenue:"

VALID_STATUSES = {"new", "qualified", "booked", "no_show", "closed_won", "closed_lost"}
VALID_REVENUE_TIERS = {"starter", "growth", "scale"}


def extract_campaign_from_tags(tags: list[str]) -> dict[str, str | None]:
    """Parse ManyChat-style tags and extract attribution fields.

    Returns dict with keys: campaign, source, status, revenue.
    """
    result: dict[str, str | None] = {
        "campaign": None,
        "source": None,
        "status": None,
        "revenue": None,
    }
    for tag in tags:
        tag = tag.strip().lower()
        if tag.startswith(TAG_PREFIX_CAMPAIGN):
            result["campaign"] = tag[len(TAG_PREFIX_CAMPAIGN):].strip() or None
        elif tag.startswith(TAG_PREFIX_SOURCE):
            result["source"] = tag[len(TAG_PREFIX_SOURCE):].strip() or None
        elif tag.startswith(TAG_PREFIX_STATUS):
            val = tag[len(TAG_PREFIX_STATUS):].strip()
            if val in VALID_STATUSES:
                result["status"] = val
        elif tag.startswith(TAG_PREFIX_REVENUE):
            val = tag[len(TAG_PREFIX_REVENUE):].strip()
            if val in VALID_REVENUE_TIERS:
                result["revenue"] = val
    return result


def resolve_contact_key(
    *,
    ghl_contact_id: str | None = None,
    manychat_subscriber_id: str | None = None,
    phone: str | None = None,
    email: str | None = None,
) -> str | None:
    """Resolve canonical contact key in priority order."""
    if ghl_contact_id and ghl_contact_id.strip():
        return ghl_contact_id.strip()
    if manychat_subscriber_id and manychat_subscriber_id.strip():
        return manychat_subscriber_id.strip()
    if phone:
        normalized = _normalize_phone(phone)
        if normalized:
            return f"phone:{normalized}"
    if email and email.strip():
        return f"email:{email.strip().lower()}"
    return None


def _normalize_phone(phone: str) -> str | None:
    """Strip to digits, return E.164-ish format or None."""
    digits = re.sub(r"[^\d]", "", phone.strip())
    if len(digits) < 7:
        return None
    if len(digits) == 10:
        digits = "1" + digits  # assume US
    return f"+{digits}"


def record_touchpoint(
    conn: sqlite3.Connection,
    *,
    contact_key: str,
    touch_type: str,
    source: str,
    campaign: str | None = None,
    utm_json: dict[str, Any] | None = None,
    event_id: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Record a single attribution touchpoint. Idempotent by event_id."""
    if event_id:
        existing = conn.execute(
            "SELECT touch_id FROM attribution_touchpoints WHERE touch_id=?",
            (event_id,),
        ).fetchone()
        if existing:
            return {"action": "touchpoint_already_exists", "touch_id": event_id}

    touch_id = event_id or new_id("touch")
    ts = datetime.now(tz=UTC).isoformat()

    if settings.DRY_RUN:
        return {
            "action": "would_record_touchpoint",
            "touch_id": touch_id,
            "contact_key": contact_key,
            "touch_type": touch_type,
        }

    conn.execute(
        """INSERT INTO attribution_touchpoints
           (touch_id, contact_key, touch_type, source, campaign, utm_json, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            touch_id,
            contact_key,
            touch_type,
            source,
            campaign,
            json.dumps(utm_json or {}, ensure_ascii=False),
            ts,
        ),
    )
    conn.commit()

    write_audit(
        conn,
        action="attribution.touchpoint_recorded",
        target=contact_key,
        payload={"touch_id": touch_id, "touch_type": touch_type, "source": source, "campaign": campaign},
        correlation_id=correlation_id,
    )

    return {"action": "touchpoint_recorded", "touch_id": touch_id, "contact_key": contact_key}


def update_lead_attribution(
    conn: sqlite3.Connection,
    *,
    contact_key: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Recompute lead_attribution for a contact using first/last touch logic.

    Primary campaign is deterministic: first-touch campaign wins.
    """
    rows = conn.execute(
        "SELECT * FROM attribution_touchpoints WHERE contact_key=? ORDER BY ts ASC",
        (contact_key,),
    ).fetchall()

    if not rows:
        return {"action": "no_touchpoints", "contact_key": contact_key}

    rows = [dict(r) for r in rows]
    first = rows[0]
    last = rows[-1]

    # Determine primary campaign: first touch with a campaign wins
    primary_campaign = None
    for r in rows:
        if r.get("campaign"):
            primary_campaign = r["campaign"]
            break

    # Confidence based on UTM presence
    confidence = "low"
    for r in rows:
        utm = r.get("utm_json")
        if utm and utm != "{}":
            try:
                parsed = json.loads(utm) if isinstance(utm, str) else utm
                if parsed.get("utm_campaign"):
                    confidence = "high"
                    break
            except (json.JSONDecodeError, AttributeError):
                pass
    if confidence == "low" and primary_campaign:
        confidence = "medium"

    ts = datetime.now(tz=UTC).isoformat()

    if settings.DRY_RUN:
        return {
            "action": "would_update_lead_attribution",
            "contact_key": contact_key,
            "primary_campaign": primary_campaign,
            "confidence": confidence,
        }

    conn.execute(
        """INSERT INTO lead_attribution
           (contact_key, first_touch_id, last_touch_id, primary_campaign, confidence, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(contact_key) DO UPDATE SET
             last_touch_id=excluded.last_touch_id,
             primary_campaign=COALESCE(lead_attribution.primary_campaign, excluded.primary_campaign),
             confidence=excluded.confidence,
             updated_at=excluded.updated_at""",
        (
            contact_key,
            first["touch_id"],
            last["touch_id"],
            primary_campaign,
            confidence,
            ts,
        ),
    )
    conn.commit()

    return {
        "action": "lead_attribution_updated",
        "contact_key": contact_key,
        "primary_campaign": primary_campaign,
        "confidence": confidence,
        "touchpoint_count": len(rows),
    }


def record_revenue_attribution(
    conn: sqlite3.Connection,
    *,
    stripe_event_id: str,
    contact_key: str,
    amount: int,
    currency: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Record revenue attribution. Idempotent by stripe_event_id."""
    existing = conn.execute(
        "SELECT stripe_event_id FROM revenue_attribution WHERE stripe_event_id=?",
        (stripe_event_id,),
    ).fetchone()
    if existing:
        return {"action": "revenue_already_attributed", "stripe_event_id": stripe_event_id}

    # Look up campaign from lead_attribution
    la = conn.execute(
        "SELECT primary_campaign FROM lead_attribution WHERE contact_key=?",
        (contact_key,),
    ).fetchone()
    campaign = la["primary_campaign"] if la else None

    ts = datetime.now(tz=UTC).isoformat()

    if settings.DRY_RUN:
        return {
            "action": "would_record_revenue_attribution",
            "stripe_event_id": stripe_event_id,
            "contact_key": contact_key,
            "amount": amount,
            "campaign": campaign,
        }

    conn.execute(
        """INSERT INTO revenue_attribution
           (stripe_event_id, contact_key, amount, currency, campaign, ts)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (stripe_event_id, contact_key, amount, currency, campaign, ts),
    )
    conn.commit()

    write_audit(
        conn,
        action="attribution.revenue_recorded",
        target=contact_key,
        payload={"stripe_event_id": stripe_event_id, "amount": amount, "campaign": campaign},
        correlation_id=correlation_id,
    )

    return {
        "action": "revenue_attributed",
        "stripe_event_id": stripe_event_id,
        "contact_key": contact_key,
        "amount": amount,
        "campaign": campaign,
    }


def get_attribution_backlog_count(conn: sqlite3.Connection) -> int:
    """Count contacts with touchpoints but no lead_attribution row."""
    row = conn.execute(
        """SELECT COUNT(DISTINCT t.contact_key) FROM attribution_touchpoints t
           LEFT JOIN lead_attribution la ON t.contact_key = la.contact_key
           WHERE la.contact_key IS NULL"""
    ).fetchone()
    return int(row[0]) if row else 0
