from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.client import NotionClient
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirrors")


def upsert_lead_mirror(
    conn: sqlite3.Connection,
    notion: NotionClient,
    *,
    lead_id: str,
    notion_leads_db_id: str,
    correlation_id: str,
) -> dict[str, Any]:
    """Ensure Notion lead record exists and matches canonical fields.

    - Lookup by ghl_contact_id → manychat_contact_id → ig_handle
    - Create if missing, update if found
    """
    lead = conn.execute(
        "SELECT * FROM agencyu_leads WHERE id=? LIMIT 1", (lead_id,)
    ).fetchone()
    if not lead:
        return {"error": "lead_not_found", "lead_id": lead_id}

    ghl_contact_id = lead["ghl_contact_id"]
    manychat_contact_id = lead["manychat_contact_id"]
    ig_handle = lead["instagram_handle"]

    props = _build_notion_lead_properties(lead)

    if settings.DRY_RUN:
        return {
            "dry_run": True,
            "action": "upsert_lead_mirror",
            "lead_id": lead_id,
            "properties": props,
        }

    page_id = _find_existing_lead_page(
        notion, notion_leads_db_id, ghl_contact_id, manychat_contact_id, ig_handle
    )

    if page_id:
        notion.update_page(page_id, props)
        _save_mirror(conn, "lead", page_id, notion_leads_db_id, ghl_contact_id, lead_id, correlation_id)
        return {"updated": True, "page_id": page_id}

    created = notion.create_page(notion_leads_db_id, props)
    page_id = created.get("id")
    _save_mirror(conn, "lead", page_id, notion_leads_db_id, ghl_contact_id, lead_id, correlation_id)
    return {"created": True, "page_id": page_id}


def _find_existing_lead_page(
    notion: NotionClient,
    db_id: str,
    ghl_contact_id: str | None,
    manychat_contact_id: str | None,
    ig_handle: str | None,
) -> str | None:
    """Search Notion DB for existing lead page by identity chain."""
    filters: list[dict[str, Any]] = []
    if ghl_contact_id:
        filters.append({"property": "ghl_contact_id", "rich_text": {"equals": ghl_contact_id}})
    if manychat_contact_id:
        filters.append({"property": "manychat_contact_id", "rich_text": {"equals": manychat_contact_id}})
    if ig_handle:
        filters.append({"property": "IG handle", "rich_text": {"equals": ig_handle}})

    for f in filters:
        resp = notion.query_db(db_id, filter_=f)
        results = resp.get("results") or []
        if results:
            return results[0].get("id")
    return None


def _build_notion_lead_properties(lead_row: dict[str, Any] | sqlite3.Row) -> dict[str, Any]:
    """Map DB lead fields to Notion properties."""
    stage = lead_row["stage"] if lead_row["stage"] else "new"
    name = lead_row["instagram_handle"] or lead_row["email"] or "Lead"

    props: dict[str, Any] = {
        "Name": {"title": [{"text": {"content": name}}]},
        "ghl_contact_id": {"rich_text": [{"text": {"content": lead_row["ghl_contact_id"] or ""}}]},
        "manychat_contact_id": {"rich_text": [{"text": {"content": lead_row["manychat_contact_id"] or ""}}]},
        "Stage": {"select": {"name": stage}},
        "Attribution JSON": {"rich_text": [{"text": {"content": lead_row["attribution_json"] or "{}"}}]},
    }

    if lead_row["campaign"]:
        props["Campaign"] = {"select": {"name": lead_row["campaign"]}}
    if lead_row["source"]:
        props["Source"] = {"select": {"name": lead_row["source"]}}
    if lead_row["revenue_tier"]:
        props["Revenue Tier"] = {"select": {"name": lead_row["revenue_tier"]}}
    if lead_row["pain_point"]:
        props["Pain Point"] = {"select": {"name": lead_row["pain_point"]}}

    return props


def _save_mirror(
    conn: sqlite3.Connection,
    mirror_type: str,
    notion_page_id: str,
    notion_db_id: str,
    ghl_contact_id: str | None,
    lead_id: str | None,
    correlation_id: str,
) -> None:
    now = utc_now_iso()
    conn.execute(
        """INSERT INTO notion_mirrors
           (id, created_at, updated_at, mirror_type, ghl_contact_id, lead_id,
            notion_page_id, notion_db_id, last_sync_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(mirror_type, notion_page_id) DO UPDATE SET
             updated_at=excluded.updated_at,
             ghl_contact_id=excluded.ghl_contact_id,
             lead_id=excluded.lead_id,
             notion_db_id=excluded.notion_db_id,
             last_sync_at=excluded.last_sync_at,
             last_error=NULL""",
        (
            f"nm_{notion_page_id}",
            now, now,
            mirror_type,
            ghl_contact_id,
            lead_id,
            notion_page_id,
            notion_db_id,
            now,
            None,
        ),
    )
    conn.commit()
