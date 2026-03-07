"""Executor for ``meta.apply_partial_scale_bundle``.

Applies the "now" portion of a partial scale and queues the remainder
for tomorrow (approval-gated when it runs).

Safe-mode default: simulates all mutations and writes audit log.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit


def execute_partial_scale_bundle(
    conn: sqlite3.Connection,
    payload: dict[str, Any],
    *,
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Execute (or simulate) a partial-scale bundle.

    Parameters
    ----------
    conn : sqlite3.Connection
        Database with ``audit_log`` and ``scheduled_actions`` tables.
    payload : dict
        Must contain: ``delta_now_usd``, ``delta_later_usd``, ``next_run_at``,
        ``brand``, ``correlation_id``.  Optionally ``original_action_payload``.
    safe_mode : bool
        When *True* (default), simulates and writes audit only.

    Returns a summary dict.
    """
    delta_now = float(payload.get("delta_now_usd") or 0)
    delta_later = float(payload.get("delta_later_usd") or 0)
    next_run_at = payload.get("next_run_at", "")
    brand = payload.get("brand", "fulldigital")
    combo_id = payload.get("combo_id", "")
    correlation_id = payload.get("correlation_id", "")
    original = payload.get("original_action_payload") or {}

    # Step 1: apply now (simulate if safe_mode)
    now_action = "simulated" if safe_mode else "applied"
    if delta_now > 0:
        write_audit(
            conn,
            action=f"meta_partial_scale_{now_action}",
            target="meta.apply_partial_scale_bundle",
            payload={
                "delta_now_usd": delta_now,
                "original_action_payload": original,
                "safe_mode": safe_mode,
            },
            correlation_id=correlation_id,
        )
        # In non-safe mode, the actual Meta API call would go here.
        # For v1 we only persist to audit and let the operator handle it.

    # Step 2: queue remainder for tomorrow (still approval-gated)
    later_queued = False
    if delta_later > 0 and next_run_at:
        from packages.agencyu.jobs.scheduler import enqueue_scheduled_action

        if safe_mode:
            write_audit(
                conn,
                action="meta_scale_remainder_simulated",
                target="meta.check_remainder_stability",
                payload={
                    "delta_later_usd": delta_later,
                    "next_run_at": next_run_at,
                    "safe_mode": True,
                },
                correlation_id=correlation_id,
            )
        else:
            enqueue_scheduled_action(
                conn,
                run_at_iso=next_run_at,
                action_type="meta.check_remainder_stability",
                brand=brand,
                payload={
                    "delta_usd": delta_later,
                    "combo_id": combo_id,
                    "original_action_payload": original,
                    "risk_level": "high",
                    "why_now": (
                        "Queued remainder from prior blocked scale (cap-limited)."
                    ),
                    "rollback_plan": (
                        "Rollback: restore prior budgets; "
                        "pause newly scaled objects."
                    ),
                },
                correlation_id=correlation_id,
            )
            write_audit(
                conn,
                action="meta_scale_remainder_queued",
                target="meta.check_remainder_stability",
                payload={
                    "delta_later_usd": delta_later,
                    "next_run_at": next_run_at,
                },
                correlation_id=correlation_id,
            )
        later_queued = True

    return {
        "ok": True,
        "safe_mode": safe_mode,
        "delta_now_usd": delta_now,
        "delta_later_usd": delta_later,
        "next_run_at": next_run_at,
        "later_queued": later_queued,
    }
