from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.agencyu.manychat.tags import parse_manychat_tags
from packages.agencyu.models import LeadStage, LeadUpsert
from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.manychat.ingest")


def ingest_manychat_event(
    conn: sqlite3.Connection,
    payload: dict[str, Any],
    *,
    correlation_id: str,
) -> dict[str, Any]:
    """Ingest a ManyChat webhook payload.

    - Validate minimal fields
    - Parse tags
    - Upsert agencyu_leads
    - Schedule downstream sync (GHL + Notion mirror) via scheduled_actions
    """
    contact = payload.get("contact") or payload.get("subscriber") or {}
    manychat_contact_id = str(contact.get("id") or "") or None
    ig_handle = contact.get("instagram_username") or contact.get("ig_handle") or None
    email = contact.get("email") or None
    phone = contact.get("phone") or None
    tags = contact.get("tags") or payload.get("tags") or []

    # Normalize tags to strings
    tag_strings: list[str] = []
    for t in tags:
        if isinstance(t, dict):
            tag_strings.append(t.get("name", ""))
        elif isinstance(t, str):
            tag_strings.append(t)

    parsed = parse_manychat_tags(tag_strings)
    stage = parsed.stage or LeadStage.NEW

    upsert = LeadUpsert(
        manychat_contact_id=manychat_contact_id,
        ghl_contact_id=None,  # resolved later via chain
        instagram_handle=ig_handle,
        email=email,
        phone=phone,
        stage=stage,
        revenue_tier=parsed.revenue_tier,
        pain_point=parsed.pain_point,
        source=parsed.source,
        campaign=parsed.campaign,
        engaged_flags=parsed.engaged_flags,
        appointment_ts=None,
        attribution_json={
            "campaign": parsed.campaign,
            "source": parsed.source.value if parsed.source else None,
        },
    )

    if settings.DRY_RUN:
        return {
            "action": "would_ingest_manychat_event",
            "manychat_contact_id": manychat_contact_id,
            "stage": stage.value,
            "campaign": parsed.campaign,
        }

    lead_id = _upsert_lead(conn, upsert)

    write_audit(
        conn,
        action="manychat.ingest",
        target=lead_id,
        payload={
            "manychat_contact_id": manychat_contact_id,
            "stage": stage.value,
            "campaign": parsed.campaign,
        },
        correlation_id=correlation_id,
    )

    # Schedule downstream resolve + mirror sync
    from packages.common.clock import utc_now_iso

    conn.execute(
        """INSERT INTO scheduled_actions
           (action_type, run_at_iso, payload_json, status, created_ts)
           VALUES (?, ?, ?, 'pending', ?)""",
        (
            "AGENCYU_RESOLVE_AND_MIRROR",
            utc_now_iso(),
            json.dumps({"lead_id": lead_id}),
            utc_now_iso(),
        ),
    )
    conn.commit()

    return {"action": "ingested", "lead_id": lead_id, "stage": stage.value}


def _upsert_lead(conn: sqlite3.Connection, upsert: LeadUpsert) -> str:
    from packages.common.clock import utc_now_iso

    now = utc_now_iso()

    existing = conn.execute(
        "SELECT id FROM agencyu_leads WHERE manychat_contact_id=? LIMIT 1",
        (upsert.manychat_contact_id,),
    ).fetchone()

    if existing:
        lead_id = existing["id"]
        conn.execute(
            """UPDATE agencyu_leads
               SET updated_at=?, instagram_handle=?, email=?, phone=?,
                   stage=?, revenue_tier=?, pain_point=?, source=?, campaign=?,
                   engaged_flags=?, attribution_json=?
               WHERE id=?""",
            (
                now,
                upsert.instagram_handle,
                upsert.email,
                upsert.phone,
                upsert.stage.value,
                upsert.revenue_tier.value if upsert.revenue_tier else None,
                upsert.pain_point.value if upsert.pain_point else None,
                upsert.source.value if upsert.source else None,
                upsert.campaign,
                json.dumps(upsert.engaged_flags),
                json.dumps(upsert.attribution_json),
                lead_id,
            ),
        )
        conn.commit()
        return lead_id

    lead_id = new_id("lead")
    conn.execute(
        """INSERT INTO agencyu_leads (
             id, created_at, updated_at,
             ghl_contact_id, manychat_contact_id, instagram_handle, email, phone,
             stage, revenue_tier, pain_point, source, campaign,
             engaged_flags, appointment_ts, attribution_json,
             last_touch_ts, last_touch_channel, last_touch_note
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            lead_id, now, now,
            upsert.ghl_contact_id, upsert.manychat_contact_id,
            upsert.instagram_handle, upsert.email, upsert.phone,
            upsert.stage.value,
            upsert.revenue_tier.value if upsert.revenue_tier else None,
            upsert.pain_point.value if upsert.pain_point else None,
            upsert.source.value if upsert.source else None,
            upsert.campaign,
            json.dumps(upsert.engaged_flags),
            upsert.appointment_ts,
            json.dumps(upsert.attribution_json),
            None, None, None,
        ),
    )
    conn.commit()
    return lead_id
