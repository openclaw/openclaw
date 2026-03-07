from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.agencyu.notion.system_state import SystemState
from packages.common.config import settings
from packages.common.cooldown import get_cooldown, reset_cooldown
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("webhook_gateway.routes.admin_system")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


@router.get("/cooldown")
def admin_get_cooldown(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Return current cooldown / circuit breaker state."""
    return {"ok": True, **get_cooldown(_conn)}


@router.post("/cooldown/reset")
def admin_reset_cooldown(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Manually clear cooldown state and reset failure counter."""
    reset_cooldown(_conn)
    return {"ok": True, "action": "cooldown_reset", **get_cooldown(_conn)}


@router.get("/state")
def admin_get_system_state(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Read-only dump of system state (system_state + system_settings KV pairs).

    Includes Notion health summary, queue depth, cooldown, write_lock status.
    """
    state = SystemState(_conn)
    return {
        "ok": True,
        "kv": state.dump_all_kv(),
        "notion_health": state.get_notion_health_summary(),
    }


class DailyReconcileRequest(BaseModel):
    request_mutations: bool = True
    correlation_id: str = ""


@router.post("/daily_reconcile")
def admin_daily_reconcile(
    payload: DailyReconcileRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run the daily reconcile job (Views Registry ensure + heal).

    Respects write_lock + cooldown. Defaults to requesting mutations
    but the guard may block if system state doesn't allow it.
    """
    try:
        from packages.agencyu.notion.client import NotionClient
        from packages.agencyu.notion.notion_api import NotionAPI
        from packages.domain.daily_reconcile import run_daily_reconcile

        api = NotionAPI(client=NotionClient())
        result = run_daily_reconcile(
            _conn,
            api,
            request_mutations=payload.request_mutations,
            correlation_id=payload.correlation_id,
        )
        return result
    except Exception as exc:
        log.error("daily_reconcile_error", extra={"error": str(exc)})
        return {"ok": False, "error": str(exc)}
