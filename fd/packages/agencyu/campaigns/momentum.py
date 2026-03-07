from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.campaigns.momentum")


def create_momentum_campaign(
    conn: sqlite3.Connection,
    *,
    utm_campaign: str,
    notes: str | None = None,
    sprint_days: int = 14,
) -> str:
    """Create a momentum campaign record."""
    now = utc_now_iso()
    cid = new_id("camp")
    conn.execute(
        """INSERT INTO campaigns
           (id, type, utm_campaign, start_ts, end_ts, notes, created_at, updated_at)
           VALUES (?, 'momentum', ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(type, utm_campaign) DO UPDATE SET updated_at=excluded.updated_at""",
        (cid, utm_campaign, now, json.dumps({"sprint_days": sprint_days, "notes": notes}), now, now),
    )
    conn.commit()
    return cid


def stop_momentum_campaign(
    conn: sqlite3.Connection,
    *,
    campaign_id: str,
) -> dict[str, Any]:
    """Stop a momentum campaign by setting end_ts."""
    now = utc_now_iso()

    if settings.DRY_RUN:
        return {"action": "would_stop_momentum_campaign", "campaign_id": campaign_id}

    conn.execute(
        "UPDATE campaigns SET end_ts=?, updated_at=? WHERE id=? AND type='momentum'",
        (now, now, campaign_id),
    )
    conn.commit()
    return {"action": "momentum_campaign_stopped", "campaign_id": campaign_id}
