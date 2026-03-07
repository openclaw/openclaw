"""Skills Checklist Template — creates per-skill checklist pages under a root page.

Each checklist page contains:
- OpenClaw markers for the skill
- Safety review to_do blocks
- Fork plan to_do blocks
- Decision to_do blocks
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.mirror.page_blocks import (
    callout,
    divider,
    heading_2,
    heading_3,
    paragraph,
    to_do,
)
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.skills_checklist_template")

_MARKER_PREFIX = "SKILL_CHECKLIST"


def _marker_start(skill_key: str) -> str:
    safe_key = skill_key.upper().replace(".", "_").replace("-", "_")
    return f"[[OPENCLAW:{_MARKER_PREFIX}_{safe_key}:START]]"


def _marker_end(skill_key: str) -> str:
    safe_key = skill_key.upper().replace(".", "_").replace("-", "_")
    return f"[[OPENCLAW:{_MARKER_PREFIX}_{safe_key}:END]]"


def _build_checklist_blocks(
    skill_key: str,
    title: str,
    source_url: str,
    trust_tier: str,
    fit_score: float,
    risk_score: float,
    recommended_mode: str,
    pain_point: str = "",
    notes: str = "",
) -> list[dict[str, Any]]:
    """Build the Notion blocks for a skill checklist page."""
    blocks: list[dict[str, Any]] = []

    # OpenClaw markers
    blocks.append(paragraph(_marker_start(skill_key), color="gray"))

    # Header
    blocks.append(heading_2(f"Fork Checklist: {title}"))
    blocks.append(callout(
        f"Skill: {skill_key} | Trust: {trust_tier} | "
        f"Fit: {fit_score:.1f} | Risk: {risk_score:.1f} | "
        f"Mode: {recommended_mode}",
        icon="info",
        color="blue_background",
    ))

    if source_url:
        blocks.append(paragraph(f"Source: {source_url}", color="gray"))
    if pain_point:
        blocks.append(paragraph(f"Pain point: {pain_point}", color="gray"))
    if notes:
        blocks.append(paragraph(f"Notes: {notes}", color="gray"))

    blocks.append(divider())

    # Safety review
    blocks.append(heading_3("Safety Review"))
    blocks.append(to_do("Read SKILL.md completely"))
    blocks.append(to_do("Check license compatibility (MIT/Apache preferred)"))
    blocks.append(to_do("Review all scripts for shell exec, network calls, file writes"))
    blocks.append(to_do("Verify no secret/credential requirements beyond .env"))
    blocks.append(to_do("Confirm no auto-install or post-install hooks"))

    blocks.append(divider())

    # Fork plan
    blocks.append(heading_3("Fork Plan"))
    blocks.append(to_do("Copy skill into /openclaw/skills_forked/"))
    blocks.append(to_do("Set safe_mode: true in skill config"))
    blocks.append(to_do("Run skill in dry-run mode locally"))
    blocks.append(to_do("Verify no external writes without check_write_allowed()"))

    blocks.append(divider())

    # Decision
    blocks.append(heading_3("Decision"))
    blocks.append(to_do("APPROVE: Safe to use with safe_mode defaults"))
    blocks.append(to_do("REJECT: Document reason and mark do_not_install"))

    # Close marker
    blocks.append(paragraph(_marker_end(skill_key), color="gray"))

    return blocks


def create_skill_checklist_page(
    *,
    notion_api: NotionAPI,
    root_page_id: str,
    skill_key: str,
    title: str,
    source_url: str = "",
    trust_tier: str = "unknown",
    fit_score: float = 0.0,
    risk_score: float = 0.0,
    recommended_mode: str = "confirm_only",
    pain_point: str = "",
    notes: str = "",
) -> dict[str, Any]:
    """Create a checklist page for a skill under the checklists root page.

    Returns:
        Dict with 'page_id' and 'url'.
    """
    parent = {"type": "page_id", "page_id": root_page_id}
    properties = {
        "title": {"title": [{"text": {"content": f"Checklist: {title} ({skill_key})"}}]},
    }

    page_id = notion_api.create_page(parent, properties)

    # Append checklist blocks to the new page
    blocks = _build_checklist_blocks(
        skill_key=skill_key,
        title=title,
        source_url=source_url,
        trust_tier=trust_tier,
        fit_score=fit_score,
        risk_score=risk_score,
        recommended_mode=recommended_mode,
        pain_point=pain_point,
        notes=notes,
    )
    notion_api.append_block_children(page_id, blocks)

    page_url = f"https://notion.so/{page_id.replace('-', '')}"

    log.info("skill_checklist_page_created", extra={
        "page_id": page_id,
        "skill_key": skill_key,
        "url": page_url,
    })

    return {"page_id": page_id, "url": page_url}
