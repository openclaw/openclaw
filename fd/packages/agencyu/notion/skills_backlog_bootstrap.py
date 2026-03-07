"""Skills Backlog DB bootstrap — create when missing.

Idempotent: if DB exists, verifies and returns. If missing, creates with
full schema under the given parent page.

Schema uses the canonical SKILLS_BACKLOG_REQUIRED_PROPS definition.
Database is named "OpenClaw — Skills Backlog" for easy search/migration.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.skills_backlog_schema import SKILLS_BACKLOG_REQUIRED_PROPS
from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.skills_backlog_bootstrap")

DB_TITLE = "OpenClaw \u2014 Skills Backlog"


@dataclass
class BootstrapResult:
    ok: bool
    mode: str  # simulate | apply
    created: bool
    db_id: str | None = None
    db_url: str | None = None
    compliance: dict[str, Any] | None = None
    blocked_reason: str | None = None


def bootstrap_skills_backlog_db(
    api: NotionAPI,
    *,
    parent_page_id: str,
    existing_db_id: str | None,
    safe_mode: bool = True,
) -> BootstrapResult:
    """Bootstrap the Skills Backlog DB.

    If existing_db_id resolves to a real database -> verify and return.
    Else create the Skills Backlog DB under parent_page_id (apply-mode only).
    """
    mode = "simulate" if safe_mode else "apply"

    # If an ID is provided, check if it exists
    if existing_db_id:
        try:
            db = api.get_database(existing_db_id)
            if db and db.get("id"):
                comp = verify_skills_backlog_db(api, existing_db_id)
                db_url = f"https://notion.so/{existing_db_id.replace('-', '')}"
                return BootstrapResult(
                    ok=True,
                    mode=mode,
                    created=False,
                    db_id=existing_db_id,
                    db_url=db_url,
                    compliance=comp.to_dict(),
                )
        except Exception:
            pass  # DB doesn't exist, fall through to create

    if safe_mode:
        return BootstrapResult(
            ok=True,
            mode="simulate",
            created=False,
            blocked_reason="db_missing_simulated",
        )

    # Create database schema payload
    props = _build_properties_payload()

    db_id = api.create_database(parent_page_id, {
        "title": DB_TITLE,
        "properties": props,
    })

    db_url = f"https://notion.so/{db_id.replace('-', '')}"

    # Verify the newly created DB
    comp = verify_skills_backlog_db(api, db_id)

    log.info("skills_backlog_db_bootstrapped", extra={
        "db_id": db_id,
        "parent_page_id": parent_page_id,
        "compliant": comp.compliant,
    })

    return BootstrapResult(
        ok=True,
        mode="apply",
        created=True,
        db_id=db_id,
        db_url=db_url,
        compliance=comp.to_dict(),
    )


def _build_properties_payload() -> dict[str, Any]:
    """Build the Notion API payload for all required properties."""
    props: dict[str, Any] = {
        "Name": {"title": {}},
    }

    for p in SKILLS_BACKLOG_REQUIRED_PROPS:
        if p.key == "Name":
            continue
        if p.notion_type == "rich_text":
            props[p.key] = {"rich_text": {}}
        elif p.notion_type == "url":
            props[p.key] = {"url": {}}
        elif p.notion_type == "number":
            props[p.key] = {"number": {"format": "number"}}
        elif p.notion_type == "date":
            props[p.key] = {"date": {}}
        elif p.notion_type == "select":
            opts = [{"name": o} for o in (p.select_options.required if p.select_options else [])]
            props[p.key] = {"select": {"options": opts}}
        elif p.notion_type == "multi_select":
            opts = [{"name": o} for o in (p.select_options.required if p.select_options else [])]
            props[p.key] = {"multi_select": {"options": opts}}

    return props
