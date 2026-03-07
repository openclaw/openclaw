"""Admin compliance endpoints — read-only Notion workspace verification.

GET /admin/notion/verify              — Full compliance check (all DBs, pages, properties, views, widgets)
GET /admin/notion/verify_command_center — Command Center only (pages, views, widgets)

Both endpoints are read-only; they never write to Notion.
Requires admin ops token.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.compliance_models import ComplianceResult
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.notion_compliance_verifier import (
    NotionComplianceVerifier,
    NotionIdMap,
)
from packages.agencyu.notion.template_manifest import load_manifest
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.compliance")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


def _build_id_map() -> NotionIdMap:
    """Build NotionIdMap from notion_bindings table + env vars."""
    page_ids: dict[str, str] = {}
    db_ids: dict[str, str] = {}

    # Load from notion_bindings
    try:
        rows = _conn.execute(
            "SELECT binding_type, notion_object_id FROM notion_bindings"
        ).fetchall()
        for row in rows:
            bt = row["binding_type"]
            nid = row["notion_object_id"]
            # Pages are bound as page_key, DBs as db_key
            # Heuristic: if it's a known page_key, put in page_ids
            if bt in ("command_center", "ops_console", "system_settings", "client_portal_root"):
                page_ids[bt] = nid
            else:
                db_ids[bt] = nid
    except Exception:
        pass

    return NotionIdMap(page_ids=page_ids, db_ids=db_ids)


def _build_verifier() -> NotionComplianceVerifier:
    """Build a live NotionComplianceVerifier with API client."""
    manifest = load_manifest()
    client = NotionClient()
    api = NotionAPI(client=client)
    ids = _build_id_map()
    return NotionComplianceVerifier(api=api, manifest=manifest, ids=ids)


@router.get("/admin/notion/verify")
def verify_notion(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Full Notion compliance check. Read-only."""
    try:
        verifier = _build_verifier()
        result = verifier.verify_all()
        return {"ok": True, **result.to_dict()}
    except Exception as exc:
        log.error("verify_notion_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}


@router.get("/admin/notion/verify_command_center")
def verify_command_center(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Command Center compliance check (pages + views + widgets). Read-only."""
    try:
        verifier = _build_verifier()
        result = verifier.verify_command_center_only()
        return {"ok": True, **result.to_dict()}
    except Exception as exc:
        log.error("verify_command_center_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}
