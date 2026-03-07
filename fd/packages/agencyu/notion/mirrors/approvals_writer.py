"""Mirror approvals queue to a Notion database (read-only display).

Upserts approval pages into the "Approvals" DB keyed by approval_id.
Respects safe_mode — simulates when Notion writes are locked.

Expected DB properties:
  - Approval ID (title)
  - Brand (select): fulldigital, cutmv
  - Action Type (rich_text)
  - Risk (select): low, medium, high
  - Spend Impact (number)
  - Why Now (rich_text)
  - Rollback Plan (rich_text)
  - Status (select): PENDING, APPROVED_STEP1, APPROVED, DENIED, EXPIRED
  - Expires At (date)
  - Correlation ID (rich_text)
  - Telegram Link (url)
"""
from __future__ import annotations

import json
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirrors.approvals_writer")


def _find_page_by_approval_id(
    api: NotionAPI,
    db_id: str,
    approval_id: str,
) -> dict[str, Any] | None:
    """Query the DB for a page matching the given approval_id."""
    filter_obj = {
        "property": "Approval ID",
        "title": {"equals": approval_id},
    }
    result = api.query_database(db_id, filter_obj=filter_obj)
    results = result.get("results", [])
    return results[0] if results else None


def _build_properties(
    approval: dict[str, Any],
    telegram_bot_username: str = "",
) -> dict[str, Any]:
    """Build Notion page properties from an approval dict."""
    approval_id = approval["approval_id"]

    # Extract spend impact from payload if available
    payload = {}
    payload_raw = approval.get("payload_json", "")
    if payload_raw:
        try:
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
        except (json.JSONDecodeError, TypeError):
            pass

    spend_impact = float(payload.get("estimated_spend_impact_usd", 0) or 0)
    why_now = str(payload.get("why_now", approval.get("summary", "")))[:1800]
    rollback_plan = str(payload.get("rollback_plan", ""))[:1800]

    tg_link = f"https://t.me/{telegram_bot_username}" if telegram_bot_username else ""

    props: dict[str, Any] = {
        "Approval ID": {"title": [{"text": {"content": approval_id}}]},
        "Brand": {"select": {"name": approval.get("brand", "unknown")}},
        "Action Type": {"rich_text": [{"text": {"content": approval.get("action_type", "")}}]},
        "Risk": {"select": {"name": approval.get("risk_level", "medium")}},
        "Spend Impact": {"number": spend_impact},
        "Why Now": {"rich_text": [{"text": {"content": why_now}}]},
        "Rollback Plan": {"rich_text": [{"text": {"content": rollback_plan}}]},
        "Status": {"select": {"name": approval.get("status", "PENDING")}},
        "Correlation ID": {"rich_text": [{"text": {"content": approval.get("correlation_id", "")}}]},
    }

    # Date fields
    expires_at = approval.get("expires_at", "")
    if expires_at:
        props["Expires At"] = {"date": {"start": expires_at}}

    # URL field
    if tg_link:
        props["Telegram Link"] = {"url": tg_link}

    return props


def mirror_approval_to_notion(
    api: NotionAPI,
    *,
    db_id: str,
    approval: dict[str, Any],
    safe_mode: bool = True,
    telegram_bot_username: str = "",
) -> dict[str, Any]:
    """Upsert a single approval to the Notion Approvals DB.

    Args:
        api: Notion API client.
        db_id: The Notion database ID for Approvals.
        approval: Approval dict from approvals_queue.
        safe_mode: If True, simulate only (no Notion writes).
        telegram_bot_username: Bot username for deep link.
    """
    aid = approval["approval_id"]
    props = _build_properties(approval, telegram_bot_username)

    if safe_mode:
        return {"ok": True, "simulated": True, "action": "upsert", "approval_id": aid}

    existing = _find_page_by_approval_id(api, db_id, aid)

    if existing:
        api.update_page(page_id=existing["id"], properties=props)
        log.info("notion_approval_updated", extra={"approval_id": aid, "page_id": existing["id"]})
        return {"ok": True, "action": "updated", "page_id": existing["id"], "approval_id": aid}

    result = api._request("POST", "/pages", {
        "parent": {"database_id": db_id},
        "properties": props,
    })
    page_id = result.get("id", "")
    log.info("notion_approval_created", extra={"approval_id": aid, "page_id": page_id})
    return {"ok": True, "action": "created", "page_id": page_id, "approval_id": aid}


def mirror_pending_approvals(
    api: NotionAPI,
    *,
    db_id: str,
    approvals: list[dict[str, Any]],
    safe_mode: bool = True,
    telegram_bot_username: str = "",
) -> dict[str, Any]:
    """Mirror all pending approvals to Notion. Returns summary."""
    results: list[dict[str, Any]] = []
    for appr in approvals:
        r = mirror_approval_to_notion(
            api,
            db_id=db_id,
            approval=appr,
            safe_mode=safe_mode,
            telegram_bot_username=telegram_bot_username,
        )
        results.append(r)

    return {
        "ok": True,
        "safe_mode": safe_mode,
        "total": len(results),
        "results": results,
    }
