"""Capacity Gate — prevents scaling when fulfillment capacity is constrained.

Rule: if capacity_available < threshold, scaling decisions become HOLD.

This prevents:
- Winning ads flooding with clients you can't fulfill
- Quality drop, refunds, churn, team burnout

Integrates with:
- packages/agencyu/sync/capacity_engine.py (existing utilization tracking)
- config/experiment_policy.yaml (capacity_gate section)
- packages/agencyu/marketing/offer_angles.py (rotation decisions)
- packages/agencyu/marketing/brain.py (policy executor)
"""
from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.operations.capacity_gate")


def get_latest_capacity(
    conn: sqlite3.Connection,
    brand: str,
) -> dict[str, Any]:
    """Get the most recent capacity state for a brand.

    Falls back to conservative defaults (unknown = block scaling for services).
    """
    try:
        row = conn.execute(
            """SELECT brand, total_hours, committed_hours, free_hours,
                      headroom_ratio, computed_at
               FROM capacity_state
               WHERE brand = ?
               ORDER BY computed_at DESC
               LIMIT 1""",
            (brand,),
        ).fetchone()

        if row:
            return {
                "brand": brand,
                "known": True,
                "total_hours": float(row["total_hours"]),
                "committed_hours": float(row["committed_hours"]),
                "free_hours": float(row["free_hours"]),
                "headroom_ratio": float(row["headroom_ratio"]),
                "computed_at": row["computed_at"],
            }
    except Exception:
        log.debug("capacity_state_query_error", exc_info=True)

    # Conservative default: unknown capacity
    return {
        "brand": brand,
        "known": False,
        "total_hours": 0,
        "committed_hours": 0,
        "free_hours": 0,
        "headroom_ratio": 0.0,
        "computed_at": None,
    }


def _override_allows_scale(
    conn: sqlite3.Connection,
) -> tuple[bool, str, dict[str, Any]]:
    """Read capacity override from Notion System Settings (via local cache).

    Returns (allowed, reason, metadata).

    Override is only active when:
    - capacity_override_ok_to_scale is true
    - capacity_override_expires_at is set and in the future
    """
    try:
        ok_row = conn.execute(
            "SELECT value FROM system_settings WHERE key='capacity_override_ok_to_scale'"
        ).fetchone()
        exp_row = conn.execute(
            "SELECT value FROM system_settings WHERE key='capacity_override_expires_at'"
        ).fetchone()
    except Exception:
        return False, "Override lookup failed", {"ok": False, "expires_at": None}

    ok = ok_row and str(ok_row[0]).lower() in ("true", "1", "yes")
    exp = exp_row[0] if exp_row else None

    if not ok:
        return False, "Override off", {"ok": False, "expires_at": exp}

    if not exp:
        return False, "Override on but expires_at missing", {"ok": True, "expires_at": None}

    try:
        exp_dt = datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False, "Override expires_at unparseable", {"ok": True, "expires_at": exp}

    now = datetime.now(UTC)
    if exp_dt <= now:
        return False, "Override expired", {"ok": True, "expires_at": exp}

    return True, "Override active", {"ok": True, "expires_at": exp}


def capacity_ok_to_scale(
    conn: sqlite3.Connection,
    brand: str,
    policy: dict[str, Any],
) -> tuple[bool, str, dict[str, Any]]:
    """Check whether capacity allows scaling for a brand.

    Returns (ok, reason_message, capacity_data).

    Checks capacity override from Notion System Settings first (fulldigital only).
    Override only bypasses the capacity gate — it does NOT bypass approval
    requirements, spend caps, kill rules, or quality gate.

    Policy shape (from experiment_policy.yaml):
        capacity_gate:
          enabled: true
          min_headroom_ratio_to_scale: 0.20
          min_free_hours_to_scale: 10
          brand_overrides:
            cutmv:
              enabled: false
            fulldigital:
              enabled: true
    """
    cfg = policy.get("capacity_gate", {})
    overrides = cfg.get("brand_overrides", {}).get(brand, {})
    enabled = overrides.get("enabled", cfg.get("enabled", False))

    if not enabled:
        return True, "capacity_gate_disabled", {"enabled": False, "brand": brand}

    # Check Notion capacity override (Full Digital only)
    if brand == "fulldigital":
        o_ok, o_msg, o_meta = _override_allows_scale(conn)
        if o_ok:
            log.info("capacity_override_active", extra={
                "brand": brand, "override_msg": o_msg, "expires_at": o_meta.get("expires_at"),
            })
            return True, f"Capacity override: {o_msg}", {"override": o_meta}

    cap = get_latest_capacity(conn, brand)

    # If unknown capacity for Full Digital: block scaling (safe default)
    if brand == "fulldigital" and not cap["known"]:
        log.info("capacity_gate_blocked_unknown", extra={"brand": brand})
        return (
            False,
            "Capacity unknown; scaling blocked until capacity_state is populated",
            cap,
        )

    min_ratio = float(cfg.get("min_headroom_ratio_to_scale", 0.20))
    min_free = float(cfg.get("min_free_hours_to_scale", 10))

    if cap["headroom_ratio"] < min_ratio:
        msg = (
            f"Capacity headroom_ratio={cap['headroom_ratio']:.2f} "
            f"below min={min_ratio:.2f}"
        )
        log.info("capacity_gate_blocked_headroom", extra={
            "brand": brand,
            "headroom_ratio": cap["headroom_ratio"],
            "min_ratio": min_ratio,
        })
        return False, msg, cap

    if cap["free_hours"] < min_free:
        msg = (
            f"Capacity free_hours={cap['free_hours']:.1f} "
            f"below min={min_free:.1f}"
        )
        log.info("capacity_gate_blocked_hours", extra={
            "brand": brand,
            "free_hours": cap["free_hours"],
            "min_free": min_free,
        })
        return False, msg, cap

    return True, "capacity_gate_passed", cap
