"""Skills Backlog Writer — creates items in the Notion Skills Backlog DB.

Each fork request creates a row with:
- Name (title): skill title
- skill_key, source_url, trust_tier, fit_score, risk_score, recommended_mode
- status: "Pending Review" (default)
- pain_point, notes, checklist_page_url
- created_at, last_updated_at (ISO dates)
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.skills.models import SkillCandidate
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.skills_backlog_writer")


def create_skills_backlog_item(
    *,
    notion_api: NotionAPI,
    database_id: str,
    candidate: SkillCandidate,
    checklist_page_url: str = "",
    pain_point: str = "",
    notes: str = "",
) -> dict[str, Any]:
    """Create a Skills Backlog DB row for a fork candidate.

    Returns:
        Dict with 'page_id' and 'url' of the created row.
    """
    now_iso = datetime.now(timezone.utc).isoformat()

    properties: dict[str, Any] = {
        "Name": {"title": [{"text": {"content": candidate.title}}]},
        "skill_key": {"rich_text": [{"text": {"content": candidate.skill_key}}]},
        "source_url": {"url": candidate.source_url or None},
        "trust_tier": {"select": {"name": candidate.trust_tier}},
        "fit_score": {"number": round(candidate.fit_score, 1)},
        "risk_score": {"number": round(candidate.risk_score, 1)},
        "recommended_mode": {"select": {"name": candidate.recommended_mode}},
        "status": {"select": {"name": "Pending Review"}},
        "pain_point": {"rich_text": [{"text": {"content": pain_point}}]},
        "notes": {"rich_text": [{"text": {"content": notes}}]},
        "checklist_page_url": {"url": checklist_page_url or None},
        "created_at": {"date": {"start": now_iso}},
        "last_updated_at": {"date": {"start": now_iso}},
    }

    parent = {"type": "database_id", "database_id": database_id}
    page_id = notion_api.create_page(parent, properties)

    log.info("skills_backlog_item_created", extra={
        "page_id": page_id,
        "skill_key": candidate.skill_key,
        "trust_tier": candidate.trust_tier,
    })

    return {
        "page_id": page_id,
        "url": f"https://notion.so/{page_id.replace('-', '')}",
    }
