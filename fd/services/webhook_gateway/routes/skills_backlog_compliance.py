"""Admin Skills Backlog compliance endpoints — verify + heal.

GET  /admin/notion/skills_backlog/verify — Check DB schema compliance
POST /admin/notion/skills_backlog/heal   — Drift heal (safe_mode default)

Requires admin ops token.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db
from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db
from packages.common.config import settings
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.skills_backlog_compliance")

router = APIRouter()


class HealRequest(BaseModel):
    safe_mode: bool = True
    allow_schema_writes: bool = False
    write_lock: bool = True


@router.get("/admin/notion/skills_backlog/verify")
def verify_skills_backlog(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Check Skills Backlog DB schema compliance. Read-only."""
    db_id = settings.NOTION_DB_SKILLS_BACKLOG_ID
    if not db_id:
        return {"ok": False, "error": "NOTION_DB_SKILLS_BACKLOG_ID not configured"}

    try:
        api = NotionAPI(client=NotionClient())
        result = verify_skills_backlog_db(api, db_id)
        return {"ok": True, "result": result.to_dict()}
    except Exception as exc:
        log.error("skills_backlog_verify_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.post("/admin/notion/skills_backlog/heal")
def heal_skills_backlog(
    payload: HealRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Drift heal the Skills Backlog DB schema.

    Schema-lock discipline:
    - safe_mode=True (default): simulate only
    - Applying requires both write_lock=False AND allow_schema_writes=True
    """
    db_id = settings.NOTION_DB_SKILLS_BACKLOG_ID
    if not db_id:
        return {"ok": False, "error": "NOTION_DB_SKILLS_BACKLOG_ID not configured"}

    # Override write_lock from NOTION_WRITE_LOCK env if set
    effective_write_lock = payload.write_lock or getattr(settings, "NOTION_WRITE_LOCK", False)

    try:
        api = NotionAPI(client=NotionClient())
        result = heal_skills_backlog_db(
            api,
            db_id,
            safe_mode=payload.safe_mode,
            allow_schema_writes=payload.allow_schema_writes,
            write_lock=effective_write_lock,
        )
        return {
            "ok": result.ok,
            "mode": result.mode,
            "blocked_reason": result.blocked_reason,
            "actions_planned": result.actions_planned,
            "actions_applied": result.actions_applied,
            "compliance_after": result.compliance_after,
        }
    except Exception as exc:
        log.error("skills_backlog_heal_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}
