"""Fix Views Registry — one-click seed + heal + rerender.

POST /admin/notion/views_registry/fix_all?safe_mode=true|false

Runs in order:
  1. seed_minimum — create missing view pages + registry rows
  2. heal — verify and repair drift in existing rows
  3. rerender CC widgets — refresh Command Center with default data

Respects write_lock + cooldown via SystemState.mutation_guard().
safe_mode=true (default) always simulates; safe_mode=false requires
guard.allow_mutations.

Requires admin ops token.
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.agencyu.notion.views_registry.healer import ViewsRegistryHealer
from packages.agencyu.notion.views_registry.seeder import ViewsRegistrySeeder
from packages.agencyu.notion.views_registry.spec import minimum_view_specs
from packages.agencyu.notion.widgets.rerender import rerender_command_center_widgets
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.ids import new_id
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.views_registry_fix")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


class FixAllRequest(BaseModel):
    safe_mode: bool = True


@router.post("/admin/notion/views_registry/fix_all")
def fix_all(
    payload: FixAllRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run seed_minimum + heal + rerender widgets in one call.

    safe_mode=true (default): simulates everything, returns what it would do.
    safe_mode=false: requires write_lock OFF and cooldown inactive.
    """
    cid = new_id("fix_views_registry")

    try:
        api = NotionAPI(client=NotionClient())
        state = SystemState(_conn)

        # --- Guard check ---
        guard = state.mutation_guard(
            request_mutations=(not payload.safe_mode),
            default_safe_mode=True,
        )

        if not payload.safe_mode and not guard.allow_mutations:
            return {
                "ok": False,
                "correlation_id": cid,
                "error": "mutations_blocked",
                "guard": asdict(guard),
                "hint": (
                    "Disable write_lock and wait for cooldown, "
                    "or run with safe_mode=true to simulate."
                ),
            }

        effective_safe = not guard.allow_mutations if not payload.safe_mode else True

        # --- Resolve Notion IDs ---
        views_registry_db_id = _get_views_registry_db_id(api)
        if not views_registry_db_id:
            return {"ok": False, "correlation_id": cid, "error": "Views Registry DB not found"}

        views_parent_page_id = _get_views_parent_page_id()
        if not views_parent_page_id:
            return {"ok": False, "correlation_id": cid, "error": "NOTION_PAGE_DB_ROOT_ID not configured"}

        cc_page_id = _get_command_center_page_id()
        if not cc_page_id:
            return {"ok": False, "correlation_id": cid, "error": "Command Center page not found in notion_bindings"}

        db_key_map = _resolve_db_key_map(api)

        specs = minimum_view_specs()

        # --- Step 1: Seed ---
        seeder = ViewsRegistrySeeder(api)
        seed_res = seeder.seed_minimum(
            views_registry_db_id=views_registry_db_id,
            views_parent_page_id=views_parent_page_id,
            db_key_to_database_id=db_key_map,
            specs=specs,
            safe_mode=effective_safe,
            correlation_id=cid,
        )

        # --- Step 2: Heal ---
        healer = ViewsRegistryHealer(api)
        heal_res = healer.heal(
            views_registry_db_id=views_registry_db_id,
            views_parent_page_id=views_parent_page_id,
            db_key_to_database_id=db_key_map,
            specs=specs,
            safe_mode=effective_safe,
            correlation_id=cid,
        )

        # --- Step 3: Rerender widgets ---
        rerender_res = rerender_command_center_widgets(
            conn=_conn,
            notion_api=api,
            command_center_page_id=cc_page_id,
            safe_mode=effective_safe,
            correlation_id=cid,
        )

        log.info("fix_all_done", extra={
            "correlation_id": cid,
            "safe_mode": effective_safe,
        })

        return {
            "ok": True,
            "correlation_id": cid,
            "safe_mode": effective_safe,
            "guard": asdict(guard),
            "steps": {
                "seed_minimum": seed_res,
                "heal": heal_res,
                "rerender_widgets": rerender_res,
            },
        }

    except Exception as exc:
        log.error("fix_all_error", extra={"error": str(exc), "correlation_id": cid})
        return {"ok": False, "correlation_id": cid, "error": str(exc)}


# ─────────────────────────────────────────
# Helpers (same patterns as views_registry.py / db_bootstrap.py)
# ─────────────────────────────────────────


def _get_views_registry_db_id(api: NotionAPI) -> str | None:
    try:
        return api.find_database_under_root("", "Views Registry (OpenClaw)")
    except Exception:
        return None


def _get_views_parent_page_id() -> str | None:
    return settings.NOTION_PAGE_DB_ROOT_ID or None


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


def _resolve_db_key_map(api: NotionAPI) -> dict[str, str]:
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
