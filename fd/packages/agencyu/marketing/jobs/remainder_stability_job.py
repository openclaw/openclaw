"""Remainder Stability Job — runs stability gate before requesting approval.

When a partial scale's remainder is queued for tomorrow, this job:
1. Pulls latest combo metrics
2. Runs the stability gate
3. If stable: creates an approval request for the remainder
4. If unstable: marks the scheduled action SKIPPED, sends info-only Telegram note

The scheduled action type is ``meta.check_remainder_stability``.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit


def run_remainder_stability_check(
    *,
    conn: sqlite3.Connection,
    policy: dict[str, Any],
    stability_gate: Any,
    action_row: dict[str, Any],
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Evaluate stability and either request approval or skip.

    Parameters
    ----------
    conn : sqlite3.Connection
        Database connection.
    policy : dict
        The ``meta`` block from experiment policy.
    stability_gate : StabilityGate
        Configured stability gate instance.
    action_row : dict
        Row from ``scheduled_actions`` with at least ``id`` and ``payload_json``.
    safe_mode : bool
        Passed through to any downstream actions.

    Returns dict with ``requested_approval`` or ``skipped`` status.
    """
    raw = action_row.get("payload_json", "{}")
    payload = json.loads(raw) if isinstance(raw, str) else raw
    brand = payload.get("brand", "fulldigital")
    combo_id = payload.get("combo_id", "")
    delta = float(payload.get("delta_usd") or 0)
    correlation_id = payload.get("correlation_id", "")
    action_id = action_row.get("id")

    gate_policy = policy.get("stability_gate", {})
    enabled = bool(gate_policy.get("enabled", True))

    if not enabled:
        # Gate disabled — proceed directly to approval request
        return _mark_passed_and_build_approval(
            conn=conn,
            action_id=action_id,
            payload=payload,
            delta=delta,
            brand=brand,
            correlation_id=correlation_id,
            stability_result=None,
        )

    result = stability_gate.evaluate(brand=brand, combo_id=combo_id)

    # Audit the evaluation
    write_audit(
        conn,
        action="stability_gate_evaluated",
        target="meta.check_remainder_stability",
        payload={
            "brand": brand,
            "combo_id": combo_id,
            "ok": result.ok,
            "reasons": result.reasons,
            "confidence": result.confidence,
            "delta_usd": delta,
        },
        correlation_id=correlation_id,
    )

    if not result.ok:
        return _handle_gate_failure(
            conn=conn,
            gate_policy=gate_policy,
            action_id=action_id,
            brand=brand,
            combo_id=combo_id,
            delta=delta,
            result=result,
            correlation_id=correlation_id,
        )

    return _mark_passed_and_build_approval(
        conn=conn,
        action_id=action_id,
        payload=payload,
        delta=delta,
        brand=brand,
        correlation_id=correlation_id,
        stability_result=result,
    )


def _handle_gate_failure(
    *,
    conn: sqlite3.Connection,
    gate_policy: dict[str, Any],
    action_id: int | None,
    brand: str,
    combo_id: str,
    delta: float,
    result: Any,
    correlation_id: str,
) -> dict[str, Any]:
    """Mark scheduled action as SKIPPED (or keep PENDING) and return info."""
    on_fail = gate_policy.get("on_fail", {})
    keep = bool(on_fail.get("keep_scheduled_action", False))
    new_status = "pending" if keep else "SKIPPED"

    now = datetime.now(UTC).isoformat()
    error_text = "; ".join(result.reasons)[:500]

    if action_id is not None:
        conn.execute(
            """UPDATE scheduled_actions
               SET status = ?, updated_ts = ?
               WHERE id = ?""",
            [new_status, now, action_id],
        )
        conn.commit()

    # Build Telegram-friendly skip message
    reason_lines = "\n- ".join(result.reasons[:6])
    telegram_text = (
        f"\U0001f9ef Remainder scale skipped (stability gate)\n"
        f"Brand: {brand}\n"
        f"Combo: {combo_id}\n"
        f"Delta: +${delta:,.0f}/day\n"
        f"Confidence: {result.confidence}\n"
        f"Reasons:\n- {reason_lines}"
    )

    return {
        "skipped": True,
        "reasons": result.reasons,
        "confidence": result.confidence,
        "new_status": new_status,
        "error_text": error_text,
        "telegram_text": telegram_text,
    }


def _mark_passed_and_build_approval(
    *,
    conn: sqlite3.Connection,
    action_id: int | None,
    payload: dict[str, Any],
    delta: float,
    brand: str,
    correlation_id: str,
    stability_result: Any | None,
) -> dict[str, Any]:
    """Mark action as PASSED and build approval request payload."""
    now = datetime.now(UTC).isoformat()

    if action_id is not None:
        conn.execute(
            """UPDATE scheduled_actions
               SET status = 'PASSED', updated_ts = ?
               WHERE id = ?""",
            [now, action_id],
        )
        conn.commit()

    confidence = stability_result.confidence if stability_result else "N/A"
    why_now = (
        f"Queued remainder is still stable (confidence {confidence})."
        if stability_result
        else "Stability gate disabled; proceeding to approval."
    )

    return {
        "requested_approval": True,
        "approval_payload": {
            "action_type": "meta.request_scale_remainder_approval",
            "brand": brand,
            "risk_level": "high",
            "estimated_spend_impact_usd": delta,
            "why_now": why_now,
            "rollback_plan": payload.get("rollback_plan")
            or "Rollback: restore prior budgets; pause newly scaled objects.",
            "payload": payload,
            "correlation_id": correlation_id,
        },
        "confidence": confidence,
    }
