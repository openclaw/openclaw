"""Daily reconcile job — ensures Views Registry compliance + runs reconcile steps.

Called from the admin endpoint or a scheduler. Respects write_lock, cooldown,
and safe-mode defaults.

Flow:
1. Check mutation guard (write_lock + cooldown)
2. Run ViewsRegistryEnsurer.ensure_cc_compliant()
3. Record reconcile success timestamp
4. Return combined result
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.agencyu.notion.views_registry.ensure import ViewsRegistryEnsurer
from packages.common.logging import get_logger

log = get_logger("domain.daily_reconcile")


def run_daily_reconcile(
    conn: sqlite3.Connection,
    api: NotionAPI,
    *,
    request_mutations: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Run the daily reconcile job.

    Steps:
    1. Evaluate mutation guard (write_lock + cooldown)
    2. Ensure Views Registry compliance (heal → seed → heal)
    3. Record success timestamp

    Args:
        conn: SQLite connection for system state.
        api: NotionAPI instance for Notion operations.
        request_mutations: Whether to request mutation permission.
            Daily reconcile normally requests mutations (True),
            but guard may still block if write_lock or cooldown is active.
        correlation_id: Tracking ID.
    """
    state = SystemState(conn)

    # Daily reconcile wants apply-mode when allowed (default_safe_mode=False)
    guard = state.mutation_guard(
        request_mutations=request_mutations,
        default_safe_mode=False,
    )

    log.info("daily_reconcile_start", extra={
        "allow_mutations": guard.allow_mutations,
        "safe_mode": guard.safe_mode,
        "reason": guard.reason,
        "write_lock": guard.write_lock,
        "cooldown_active": guard.cooldown_active,
    })

    # Run Views Registry ensure
    ensurer = ViewsRegistryEnsurer(api)
    views_result = ensurer.ensure_cc_compliant(
        allow_mutations=guard.allow_mutations,
        safe_mode=guard.safe_mode,
        reason=f"daily_reconcile:{guard.reason}",
        correlation_id=correlation_id or None,
    )

    # Brand switcher heal
    brand_switcher_result: dict[str, Any] = {}
    try:
        from packages.agencyu.notion.widgets.brand_switcher_writer import (
            BrandSwitcherWriter,
        )

        cc_page_id = _resolve_cc_page_id(conn)
        if cc_page_id:
            writer = BrandSwitcherWriter(conn, api, cc_page_id)
            brand_switcher_result = writer.seed_or_heal(
                safe_mode=guard.safe_mode,
                correlation_id=correlation_id,
            )
        else:
            brand_switcher_result = {"ok": False, "error": "command_center page not bound"}
    except Exception as exc:
        brand_switcher_result = {"ok": False, "error": str(exc)}

    # Record success
    if views_result.get("ok"):
        state.record_reconcile_success("views_registry")

    log.info("daily_reconcile_done", extra={
        "views_status": views_result.get("status"),
        "mutated": views_result.get("mutated", False),
        "brand_switcher_ok": brand_switcher_result.get("ok"),
    })

    return {
        "ok": True,
        "guard": {
            "allow_mutations": guard.allow_mutations,
            "safe_mode": guard.safe_mode,
            "reason": guard.reason,
            "write_lock": guard.write_lock,
            "cooldown_active": guard.cooldown_active,
        },
        "views_registry": views_result,
        "brand_switcher": brand_switcher_result,
    }


def _resolve_cc_page_id(conn: sqlite3.Connection) -> str | None:
    """Resolve command_center page ID from notion_bindings."""
    try:
        row = conn.execute(
            "SELECT notion_object_id FROM notion_bindings WHERE binding_type='command_center' LIMIT 1"
        ).fetchone()
        return row["notion_object_id"] if row else None
    except Exception:
        return None
