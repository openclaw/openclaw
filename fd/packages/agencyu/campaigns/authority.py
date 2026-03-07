from __future__ import annotations

import sqlite3

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.campaigns.authority")


def create_authority_campaign(
    conn: sqlite3.Connection,
    *,
    utm_campaign: str,
    notes: str | None = None,
) -> str:
    """Create or update an authority funnel campaign record."""
    now = utc_now_iso()
    cid = new_id("camp")
    conn.execute(
        """INSERT INTO campaigns
           (id, type, utm_campaign, start_ts, end_ts, notes, created_at, updated_at)
           VALUES (?, 'authority', ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(type, utm_campaign) DO UPDATE SET updated_at=excluded.updated_at""",
        (cid, utm_campaign, now, notes, now, now),
    )
    conn.commit()
    return cid


def attach_lead_to_campaign(
    conn: sqlite3.Connection,
    *,
    campaign_id: str,
    lead_id: str,
    ghl_contact_id: str | None = None,
    manychat_contact_id: str | None = None,
) -> str:
    """Attach a lead to a campaign."""
    now = utc_now_iso()
    cc_id = new_id("cc")
    conn.execute(
        """INSERT INTO campaign_contacts
           (id, campaign_id, ghl_contact_id, manychat_contact_id, lead_id, status, joined_ts, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)""",
        (cc_id, campaign_id, ghl_contact_id, manychat_contact_id, lead_id, now, now),
    )
    conn.commit()
    return cc_id


def get_campaign_report(
    conn: sqlite3.Connection,
    *,
    campaign_id: str,
) -> dict[str, int | str]:
    """Get basic campaign stats."""
    row = conn.execute(
        "SELECT * FROM campaigns WHERE id=?", (campaign_id,)
    ).fetchone()
    if not row:
        return {"error": "campaign_not_found"}

    contacts = conn.execute(
        "SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id=?",
        (campaign_id,),
    ).fetchone()

    return {
        "campaign_id": campaign_id,
        "type": row["type"],
        "utm_campaign": row["utm_campaign"],
        "contacts": int(contacts[0]) if contacts else 0,
        "start_ts": row["start_ts"],
        "end_ts": row["end_ts"],
    }
