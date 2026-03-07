"""Admin endpoints for Views Registry seeding, healing, and status.

POST /admin/notion/views_registry/seed_minimum — Create view pages + seed rows
POST /admin/notion/views_registry/heal          — Verify and repair drift
GET  /admin/notion/views_registry/status         — Read-only status check

All endpoints require admin ops token.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.views_registry.healer import ViewsRegistryHealer
from packages.agencyu.notion.views_registry.seeder import ViewsRegistrySeeder
from packages.agencyu.notion.views_registry.spec import minimum_view_specs
from packages.common.config import settings
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.views_registry")

router = APIRouter()


class SeedRequest(BaseModel):
    safe_mode: bool = True


class HealRequest(BaseModel):
    safe_mode: bool = True


@router.post("/admin/notion/views_registry/seed_minimum")
def seed_minimum(
    payload: SeedRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Create view pages and seed Views Registry rows for all required views.

    Safe-mode by default: simulates only.
    """
    try:
        api = NotionAPI(client=NotionClient())

        views_registry_db_id = _get_views_registry_db_id(api)
        if not views_registry_db_id:
            return {"ok": False, "error": "Views Registry DB not found"}

        views_parent_page_id = _get_views_parent_page_id()
        if not views_parent_page_id:
            return {"ok": False, "error": "NOTION_PAGE_DB_ROOT_ID not configured"}

        db_key_map = _resolve_db_key_map(api)

        seeder = ViewsRegistrySeeder(api)
        result = seeder.seed_minimum(
            views_registry_db_id=views_registry_db_id,
            views_parent_page_id=views_parent_page_id,
            db_key_to_database_id=db_key_map,
            specs=minimum_view_specs(),
            safe_mode=payload.safe_mode,
            correlation_id="views_seed_minimum",
        )
        return result

    except Exception as exc:
        log.error("seed_minimum_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.post("/admin/notion/views_registry/heal")
def heal(
    payload: HealRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Verify and repair Views Registry rows and their pages.

    Safe-mode by default: simulates only.
    """
    try:
        api = NotionAPI(client=NotionClient())

        views_registry_db_id = _get_views_registry_db_id(api)
        if not views_registry_db_id:
            return {"ok": False, "error": "Views Registry DB not found"}

        views_parent_page_id = _get_views_parent_page_id()
        if not views_parent_page_id:
            return {"ok": False, "error": "NOTION_PAGE_DB_ROOT_ID not configured"}

        db_key_map = _resolve_db_key_map(api)

        healer = ViewsRegistryHealer(api)
        result = healer.heal(
            views_registry_db_id=views_registry_db_id,
            views_parent_page_id=views_parent_page_id,
            db_key_to_database_id=db_key_map,
            specs=minimum_view_specs(),
            safe_mode=payload.safe_mode,
            correlation_id="views_heal",
        )
        return result

    except Exception as exc:
        log.error("heal_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.get("/admin/notion/views_registry/status")
def status(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Read-only status check of all required views."""
    try:
        api = NotionAPI(client=NotionClient())

        views_registry_db_id = _get_views_registry_db_id(api)
        if not views_registry_db_id:
            return {"ok": False, "error": "Views Registry DB not found"}

        healer = ViewsRegistryHealer(api)
        result = healer.status(
            views_registry_db_id=views_registry_db_id,
            specs=minimum_view_specs(),
        )
        return result

    except Exception as exc:
        log.error("status_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


# ─────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────


def _get_views_registry_db_id(api: NotionAPI) -> str | None:
    """Find Views Registry DB by title search."""
    try:
        return api.find_database_under_root("", "Views Registry (OpenClaw)")
    except Exception:
        return None


def _get_views_parent_page_id() -> str | None:
    """Get the parent page where view pages are created."""
    return settings.NOTION_PAGE_DB_ROOT_ID or None


def _resolve_db_key_map(api: NotionAPI) -> dict[str, str]:
    """Build db_key -> Notion database ID map by searching for each DB by title.

    Uses the manifest database titles to resolve IDs.
    """
    from packages.agencyu.notion.template_manifest import load_manifest

    manifest = load_manifest()
    db_map: dict[str, str] = {}

    for db_key, db_spec in manifest.databases.items():
        title = db_spec.get("title", "")
        if not db_key or not title:
            continue
        try:
            db_id = api.find_database_under_root("", title)
            if db_id:
                db_map[db_key] = db_id
        except Exception:
            pass

    return db_map
