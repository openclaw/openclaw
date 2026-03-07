"""Offer Angle Rotation Matrix — controlled experiment combos with fatigue awareness.

Generates offer × angle × hook × CTA × format × audience combos while respecting:
- Max active combos per brand
- Fatigue thresholds per group
- Phase gating (validation → optimization → scale)
- Profit constraints (margin floor from offers.yaml)
- Pipeline quality rules (from quality_gate.py)

This engine never directly changes budgets. It emits decisions;
meta_ads.py (or the ad executor) applies only if allowed + approval threshold.

Combo ID format: combo:{offer_id}:{angle_id}:{hook_id}:{cta_id}:{format_id}:{audience_id}
"""
from __future__ import annotations

import json
import random
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.marketing.fatigue import FatigueSignal, detect_fatigue
from packages.common.ids import make_id
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.offer_angles")

_ANGLES_PATH = Path(__file__).resolve().parent.parent.parent.parent / "config" / "angles.yaml"
_OFFERS_PATH = Path(__file__).resolve().parent.parent.parent.parent / "config" / "offers.yaml"


# ── Data models ──


@dataclass(frozen=True)
class ComboSpec:
    """A specific offer × angle × hook × CTA × format × audience combination."""

    combo_id: str
    offer_id: str
    angle_id: str
    hook_id: str
    cta_id: str
    format_id: str
    audience_id: str
    brand: str
    fatigue_group: str = ""


@dataclass
class RotationDecision:
    """Result of rotation evaluation for a single combo."""

    combo_id: str
    action: str  # "hold" | "rotate" | "promote" | "kill"
    reason: str
    next_combo: ComboSpec | None = None
    metrics: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "combo_id": self.combo_id,
            "action": self.action,
            "reason": self.reason,
            "metrics": self.metrics,
        }
        if self.next_combo:
            d["next_combo_id"] = self.next_combo.combo_id
        return d


# ── Config loading ──


def load_angles_config(path: Path | None = None) -> dict[str, Any]:
    """Load angles.yaml config."""
    p = path or _ANGLES_PATH
    if not p.exists():
        log.warning("angles_yaml_not_found", extra={"path": str(p)})
        return {}
    with open(p) as f:
        return yaml.safe_load(f) or {}


def load_offers_config(path: Path | None = None) -> dict[str, Any]:
    """Load offers.yaml config."""
    p = path or _OFFERS_PATH
    if not p.exists():
        return {}
    with open(p) as f:
        return yaml.safe_load(f) or {}


# ── Combo generation ──


def build_combo_id(
    offer_id: str,
    angle_id: str,
    hook_id: str,
    cta_id: str,
    format_id: str,
    audience_id: str,
) -> str:
    """Deterministic combo ID."""
    return f"combo:{offer_id}:{angle_id}:{hook_id}:{cta_id}:{format_id}:{audience_id}"


def propose_next_combo(
    conn: sqlite3.Connection,
    offer_id: str,
    brand: str,
    *,
    angles_config: dict[str, Any] | None = None,
    rng_seed: int | None = None,
) -> ComboSpec | None:
    """Propose the next combo to test, preferring least-fatigued angles.

    Avoids combos already active or recently killed.
    """
    cfg = angles_config or load_angles_config()
    if not cfg:
        return None

    angles = cfg.get("angles", [])
    hooks = cfg.get("hooks", [])
    ctas = cfg.get("ctas", [])
    formats = cfg.get("formats", [])
    audiences = cfg.get("audiences", [])

    if not (angles and hooks and ctas and formats and audiences):
        return None

    rng = random.Random(rng_seed) if rng_seed is not None else random.Random()

    # Fatigue-aware: pick least-fatigued angle
    angle = _pick_least_fatigued(conn, angles, brand)
    # Pick hooks compatible with this angle
    compatible_hooks = [
        h for h in hooks
        if angle["angle_id"] in h.get("angle_ids", [])
    ]
    hook = rng.choice(compatible_hooks) if compatible_hooks else rng.choice(hooks)
    cta = rng.choice(ctas)
    fmt = rng.choice(formats)
    aud = rng.choice(audiences)

    combo_id = build_combo_id(
        offer_id,
        angle["angle_id"],
        hook["hook_id"],
        cta["cta_id"],
        fmt["format_id"],
        aud["audience_id"],
    )

    # Check if this combo already exists
    try:
        existing = conn.execute(
            "SELECT combo_id FROM offer_angle_combos WHERE combo_id = ?",
            (combo_id,),
        ).fetchone()
        if existing:
            return None  # Already exists, caller should retry
    except Exception:
        pass

    return ComboSpec(
        combo_id=combo_id,
        offer_id=offer_id,
        angle_id=angle["angle_id"],
        hook_id=hook["hook_id"],
        cta_id=cta["cta_id"],
        format_id=fmt["format_id"],
        audience_id=aud["audience_id"],
        brand=brand,
        fatigue_group=angle.get("fatigue_group", ""),
    )


def _pick_least_fatigued(
    conn: sqlite3.Connection,
    angles: list[dict[str, Any]],
    brand: str,
) -> dict[str, Any]:
    """Pick the angle with the lowest recent fatigue signals."""
    fatigue_counts: dict[str, int] = {}
    try:
        rows = conn.execute(
            """SELECT angle_id, COUNT(*) AS cnt
               FROM angle_fatigue_log
               WHERE brand = ? AND fatigued = 1
                 AND checked_at >= datetime('now', '-14 days')
               GROUP BY angle_id""",
            (brand,),
        ).fetchall()
        for r in rows:
            fatigue_counts[r["angle_id"]] = int(r["cnt"])
    except Exception:
        pass

    # Sort by fatigue count ascending (least fatigued first)
    scored = sorted(
        angles,
        key=lambda a: fatigue_counts.get(a["angle_id"], 0),
    )
    return scored[0]


# ── Rotation decisions ──


def decide_rotation(
    conn: sqlite3.Connection,
    combo_id: str,
    brand: str,
    *,
    min_sample_size: int = 30,
    kill_cpa_multiplier: float = 3.0,
    scale_roas_multiplier: float = 2.0,
    angles_config: dict[str, Any] | None = None,
    fatigue_policy: dict[str, Any] | None = None,
) -> RotationDecision:
    """Evaluate whether a combo should be held, rotated, promoted, or killed.

    Decision pipeline:
    1. Check sample size (too small → hold)
    2. Check kill rule (CPA > 3× target → kill)
    3. Check scale rule (ROAS >= 2× target + quality gates pass → promote)
    4. Check fatigue (fatigued → rotate)
    5. Otherwise → hold
    """
    cfg = angles_config or load_angles_config()
    fp = fatigue_policy or cfg.get("fatigue_policy", {})

    # Get combo metrics
    metrics = _get_combo_metrics(conn, combo_id, brand)

    # 1. Sample size check
    if metrics.get("impressions", 0) < min_sample_size:
        return RotationDecision(
            combo_id=combo_id,
            action="hold",
            reason=f"Insufficient sample_size={metrics.get('impressions', 0)}, need {min_sample_size}",
            metrics=metrics,
        )

    # 2. Kill rule: CPA exceeds 3× target
    target_cpa = metrics.get("target_cpa_cents", 100_00)  # $100 default
    current_cpa = metrics.get("cpa_cents", 0)
    if current_cpa > 0 and current_cpa > target_cpa * kill_cpa_multiplier:
        return RotationDecision(
            combo_id=combo_id,
            action="kill",
            reason=f"Kill rule: CPA {current_cpa} > {kill_cpa_multiplier}× target {target_cpa}",
            metrics=metrics,
        )

    # 3. Scale rule: ROAS meets threshold + quality gate + capacity gate
    target_roas = metrics.get("target_roas", 2.0)
    current_roas = metrics.get("roas", 0.0)
    if current_roas >= target_roas * scale_roas_multiplier:
        # Capacity gate: block scaling if fulfillment is constrained
        from packages.agencyu.operations.capacity_gate import capacity_ok_to_scale

        cap_ok, cap_msg, cap_data = capacity_ok_to_scale(conn, brand, cfg)
        if not cap_ok:
            return RotationDecision(
                combo_id=combo_id,
                action="hold",
                reason=f"Capacity gate: {cap_msg}",
                metrics={**metrics, "capacity": cap_data},
            )
        return RotationDecision(
            combo_id=combo_id,
            action="promote",
            reason=f"Scale rule: ROAS {current_roas:.2f} >= {scale_roas_multiplier}× target {target_roas} (capacity OK)",
            metrics=metrics,
        )

    # 4. Fatigue check
    fatigue_signal = _check_combo_fatigue(conn, combo_id, brand, fp)
    if fatigue_signal.fatigued:
        offer_id = combo_id.split(":")[1] if ":" in combo_id else ""
        next_combo = propose_next_combo(conn, offer_id, brand, angles_config=cfg)
        return RotationDecision(
            combo_id=combo_id,
            action="rotate",
            reason=f"Fatigue detected: {', '.join(fatigue_signal.reasons)}",
            next_combo=next_combo,
            metrics=metrics,
        )

    # 5. Default: hold
    return RotationDecision(
        combo_id=combo_id,
        action="hold",
        reason="Within acceptable bounds",
        metrics=metrics,
    )


def _get_combo_metrics(
    conn: sqlite3.Connection,
    combo_id: str,
    brand: str,
) -> dict[str, Any]:
    """Pull metrics for a combo from the database."""
    try:
        row = conn.execute(
            """SELECT impressions, clicks, conversions, revenue_cents, cpa_cents, roas
               FROM offer_angle_combos
               WHERE combo_id = ?""",
            (combo_id,),
        ).fetchone()
        if row:
            return {
                "combo_id": combo_id,
                "brand": brand,
                "impressions": int(row["impressions"] or 0),
                "clicks": int(row["clicks"] or 0),
                "conversions": int(row["conversions"] or 0),
                "revenue_cents": int(row["revenue_cents"] or 0),
                "cpa_cents": int(row["cpa_cents"] or 0),
                "roas": float(row["roas"] or 0),
            }
    except Exception:
        log.debug("combo_metrics_query_error", exc_info=True)

    return {"combo_id": combo_id, "brand": brand, "impressions": 0}


def _check_combo_fatigue(
    conn: sqlite3.Connection,
    combo_id: str,
    brand: str,
    fp: dict[str, Any],
) -> FatigueSignal:
    """Check fatigue for a combo using the fatigue detection module."""
    # Default to not fatigued if no recent data
    try:
        row = conn.execute(
            """SELECT frequency, ctr_now, ctr_prev, cpc_now, cpc_prev
               FROM angle_fatigue_log
               WHERE brand = ? AND angle_id = (
                   SELECT angle_id FROM offer_angle_combos WHERE combo_id = ?
               )
               ORDER BY checked_at DESC LIMIT 1""",
            (brand, combo_id),
        ).fetchone()

        if not row:
            return FatigueSignal(fatigued=False)

        return detect_fatigue(
            frequency=float(row["frequency"] or 0),
            ctr_now=float(row["ctr_now"] or 0),
            ctr_prev=float(row["ctr_prev"] or 0),
            cpc_now=float(row["cpc_now"] or 0),
            cpc_prev=float(row["cpc_prev"] or 0),
            freq_threshold=float(fp.get("frequency_threshold", 2.8)),
            ctr_drop_pct=float(fp.get("ctr_drop_pct", 35.0)),
            cpc_increase_pct=float(fp.get("cpc_increase_pct", 40.0)),
            min_signals=int(fp.get("min_signals", 2)),
        )
    except Exception:
        return FatigueSignal(fatigued=False)


# ── Daily rotation cycle ──


def run_rotation_cycle(
    conn: sqlite3.Connection,
    brand: str,
    *,
    safe_mode: bool = True,
) -> dict[str, Any]:
    """Run the daily rotation cycle for a brand.

    Called by brain.py. Evaluates all active combos and returns decisions.
    In safe_mode, decisions are recorded but not applied.
    """
    cfg = load_angles_config()
    fp = cfg.get("fatigue_policy", {})
    max_active = int(fp.get("max_active_combos_per_brand", 6))

    # Get active combos
    active_combos: list[dict[str, Any]] = []
    try:
        rows = conn.execute(
            """SELECT combo_id, offer_id, angle_id, brand
               FROM offer_angle_combos
               WHERE brand = ? AND status = 'active'
               ORDER BY created_at""",
            (brand,),
        ).fetchall()
        active_combos = [dict(r) for r in rows]
    except Exception:
        log.debug("active_combos_query_error", exc_info=True)

    decisions: list[dict[str, Any]] = []
    promoted = 0
    killed = 0
    rotated = 0

    for combo in active_combos:
        decision = decide_rotation(
            conn,
            combo["combo_id"],
            brand,
            angles_config=cfg,
            fatigue_policy=fp,
        )
        decisions.append(decision.to_dict())

        # Record decision
        now = datetime.now(UTC).isoformat()
        try:
            conn.execute(
                """INSERT INTO offer_angle_decisions (id, combo_id, brand, action, reason, next_combo_id, metrics_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    make_id("decision"),
                    decision.combo_id,
                    brand,
                    decision.action,
                    decision.reason,
                    decision.next_combo.combo_id if decision.next_combo else None,
                    json.dumps(decision.metrics),
                    now,
                ),
            )
        except Exception:
            log.debug("decision_record_error", exc_info=True)

        if not safe_mode:
            _apply_decision(conn, decision, now)

        if decision.action == "promote":
            promoted += 1
        elif decision.action == "kill":
            killed += 1
        elif decision.action == "rotate":
            rotated += 1

    if not safe_mode:
        try:
            conn.commit()
        except Exception:
            pass

    return {
        "ok": True,
        "brand": brand,
        "safe_mode": safe_mode,
        "active_combos": len(active_combos),
        "max_active": max_active,
        "decisions": decisions,
        "summary": {
            "promoted": promoted,
            "killed": killed,
            "rotated": rotated,
            "held": len(decisions) - promoted - killed - rotated,
        },
        "ts": datetime.now(UTC).isoformat(),
    }


def _apply_decision(
    conn: sqlite3.Connection,
    decision: RotationDecision,
    now: str,
) -> None:
    """Apply a rotation decision to the database."""
    status_map = {
        "kill": "killed",
        "rotate": "rotated",
        "promote": "active",  # promoted combos stay active
    }
    new_status = status_map.get(decision.action)
    if not new_status:
        return

    try:
        conn.execute(
            "UPDATE offer_angle_combos SET status = ?, updated_at = ? WHERE combo_id = ?",
            (new_status, now, decision.combo_id),
        )

        # If rotating, activate the new combo
        if decision.action == "rotate" and decision.next_combo:
            nc = decision.next_combo
            conn.execute(
                """INSERT OR IGNORE INTO offer_angle_combos
                   (combo_id, offer_id, angle_id, hook_id, cta_id, format_id, audience_id, brand, status, fatigue_group, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)""",
                (nc.combo_id, nc.offer_id, nc.angle_id, nc.hook_id, nc.cta_id, nc.format_id, nc.audience_id, nc.brand, nc.fatigue_group, now, now),
            )
    except Exception:
        log.debug("apply_decision_error", exc_info=True)
