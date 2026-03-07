"""Admin DB bootstrap endpoints — create, verify, and render DB registry.

POST /admin/notion/db/bootstrap_skills_backlog — Create Skills Backlog DB if missing
GET  /admin/notion/db/registry_status           — Status of all OpenClaw DBs
POST /admin/notion/widgets/render_db_registry   — Write DB Registry widget to CC

All endpoints require admin ops token.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.db_bootstrap import ensure_child_page
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.skills_backlog_bootstrap import bootstrap_skills_backlog_db
from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db
from packages.agencyu.notion.widgets.cc_db_registry_writer import write_cc_db_registry
from packages.agencyu.notion.widgets.widget_heal import heal_missing_widgets
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.db_bootstrap")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


class BootstrapRequest(BaseModel):
    safe_mode: bool = True
    create_openclaw_db_home: bool = True
    existing_db_id: str | None = None


class RenderDbRegistryRequest(BaseModel):
    safe_mode: bool = True


@router.post("/admin/notion/db/bootstrap_skills_backlog")
def bootstrap_skills_backlog(
    payload: BootstrapRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Create the Skills Backlog DB if it doesn't exist.

    Safe-mode by default: simulates only.
    Optionally creates an "OpenClaw Databases" parent page for organization.
    """
    db_root_id = settings.NOTION_PAGE_DB_ROOT_ID
    if not db_root_id:
        return {"ok": False, "error": "NOTION_PAGE_DB_ROOT_ID not configured"}

    try:
        api = NotionAPI(client=NotionClient())

        # Optionally create "OpenClaw Databases" home page
        parent_page_id = db_root_id
        home_url = None
        if payload.create_openclaw_db_home:
            home = ensure_child_page(
                api, db_root_id,
                title="OpenClaw Databases",
                safe_mode=payload.safe_mode,
            )
            parent_page_id = home.page_id
            home_url = home.page_url

        existing_db_id = payload.existing_db_id or settings.NOTION_DB_SKILLS_BACKLOG_ID or None

        result = bootstrap_skills_backlog_db(
            api,
            parent_page_id=parent_page_id,
            existing_db_id=existing_db_id,
            safe_mode=payload.safe_mode,
        )

        return {
            "ok": True,
            "result": {
                "ok": result.ok,
                "mode": result.mode,
                "created": result.created,
                "db_id": result.db_id,
                "db_url": result.db_url,
                "compliance": result.compliance,
                "blocked_reason": result.blocked_reason,
            },
            "db_home_url": home_url,
        }
    except Exception as exc:
        log.error("bootstrap_skills_backlog_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.get("/admin/notion/db/registry_status")
def registry_status(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get status of all OpenClaw-managed databases."""
    db_id = settings.NOTION_DB_SKILLS_BACKLOG_ID

    status: dict[str, Any] = {
        "exists": False,
        "db_url": None,
        "compliant": None,
        "missing_props_count": None,
        "missing_options_count": None,
    }

    if not db_id:
        return {"ok": True, "skills_backlog": status}

    try:
        api = NotionAPI(client=NotionClient())
        db = api.get_database(db_id)
        if db and db.get("id"):
            comp = verify_skills_backlog_db(api, db_id)
            db_url = f"https://notion.so/{db_id.replace('-', '')}"
            status = {
                "exists": True,
                "db_url": db_url,
                "compliant": comp.compliant,
                "missing_props_count": len(comp.missing_props) + len(comp.mismatched_props),
                "missing_options_count": len(comp.missing_options),
            }
    except Exception as exc:
        log.warning("registry_status_db_error", extra={"error": str(exc)})

    return {"ok": True, "skills_backlog": status}


@router.post("/admin/notion/widgets/render_db_registry")
def render_db_registry(
    payload: RenderDbRegistryRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Render the DB Registry widget to Command Center."""
    cc_page_id = _get_command_center_page_id()
    if not cc_page_id:
        return {"ok": False, "error": "command_center page not bound in notion_bindings"}

    db_id = settings.NOTION_DB_SKILLS_BACKLOG_ID

    # Build status snapshot
    status: dict[str, Any] = {"exists": False}
    if db_id:
        try:
            api = NotionAPI(client=NotionClient())
            db = api.get_database(db_id)
            if db and db.get("id"):
                comp = verify_skills_backlog_db(api, db_id)
                db_url = f"https://notion.so/{db_id.replace('-', '')}"
                status = {
                    "exists": True,
                    "db_url": db_url,
                    "compliant": comp.compliant,
                    "missing_props_count": len(comp.missing_props) + len(comp.mismatched_props),
                    "missing_options_count": len(comp.missing_options),
                }
        except Exception:
            pass

    try:
        api = NotionAPI(client=NotionClient())
        result = write_cc_db_registry(
            conn=_conn,
            notion_api=api,
            command_center_page_id=cc_page_id,
            db_root_page_url=None,
            skills_backlog=status,
            safe_mode=payload.safe_mode,
            correlation_id="render_db_registry",
        )
        return {
            "ok": True,
            "mode": "simulate" if payload.safe_mode else "apply",
            "result": result,
        }
    except Exception as exc:
        log.error("render_db_registry_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


class HealWidgetsRequest(BaseModel):
    safe_mode: bool = True
    missing_widget_keys: list[str] = []


@router.post("/admin/notion/widgets/heal_missing")
def heal_missing(
    payload: HealWidgetsRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Write missing widgets to Command Center with default placeholder data.

    Provide missing_widget_keys from a compliance check, or leave empty
    to auto-detect missing widgets.
    """
    cc_page_id = _get_command_center_page_id()
    if not cc_page_id:
        return {"ok": False, "error": "command_center page not bound in notion_bindings"}

    try:
        api = NotionAPI(client=NotionClient())
        result = heal_missing_widgets(
            conn=_conn,
            notion_api=api,
            command_center_page_id=cc_page_id,
            missing_widget_keys=payload.missing_widget_keys,
            safe_mode=payload.safe_mode,
            correlation_id="heal_missing_widgets",
        )
        return result
    except Exception as exc:
        log.error("heal_missing_widgets_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


def _get_command_center_page_id() -> str | None:
    """Look up command_center page ID from notion_bindings table."""
    try:
        row = _conn.execute(
            "SELECT notion_object_id FROM notion_bindings "
            "WHERE binding_type='command_center' LIMIT 1"
        ).fetchone()
        return row["notion_object_id"] if row else None
    except Exception:
        return None
