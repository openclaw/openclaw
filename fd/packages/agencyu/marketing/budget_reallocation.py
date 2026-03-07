"""Budget Reallocation Planner — suggests pause candidates when budget is BLOCKED.

Safe-mode only (v1): generates a text plan with pause candidates to free budget.
Does NOT execute any changes — just recommends.

When a Meta approval is BLOCKED (projected > cap), this module:
1. Fetches active budgets from ``meta_active_budgets``
2. Optionally enriches with combo performance data
3. Picks the minimal set of pause candidates that frees the required budget
4. Returns a ``ReallocationPlan`` for rendering in Telegram

Usage::

    planner = BudgetReallocationPlanner(conn)
    plan = planner.suggest_plan(
        brand="fulldigital",
        cap_usd=200,
        current_total_usd=180,
        delta_usd=30,
    )
    # plan.candidates -> list of PauseCandidate
    # plan.summary_lines -> human-readable summary
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class PauseCandidate:
    """A single campaign/adset recommended for pausing."""

    object_type: str  # "campaign" | "adset"
    object_id: str
    object_name: str
    daily_budget_usd: float
    reason: str
    confidence: str  # LOW | MED | HIGH


@dataclass
class ReallocationPlan:
    """A complete reallocation suggestion."""

    blocked_delta_usd: float
    cap_usd: float
    current_total_usd: float
    projected_total_usd: float
    required_free_usd: float
    candidates: list[PauseCandidate]
    summary_lines: list[str]
    meta: dict[str, Any] = field(default_factory=dict)


class BudgetReallocationPlanner:
    """Produces a text plan: pause candidates to free budget.

    Safe-mode only: doesn't apply changes, just suggests.

    Parameters
    ----------
    conn : sqlite3.Connection
        Database connection with ``meta_active_budgets`` table.
    combo_store : object | None
        Optional performance data source.  When provided, must expose
        ``get_perf_by_meta_object(object_id) -> dict | None``.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        combo_store: Any = None,
    ) -> None:
        self.conn = conn
        self.combo_store = combo_store

    # ── Data fetching ──

    def _fetch_active_budgets(self, brand: str | None = None) -> list[dict[str, Any]]:
        """Return active budgets ordered by daily_budget_usd descending."""
        if brand:
            rows = self.conn.execute(
                """SELECT brand, object_type, object_id, object_name, daily_budget_usd
                   FROM meta_active_budgets
                   WHERE is_active = 1 AND brand = ?
                   ORDER BY daily_budget_usd DESC""",
                [brand],
            ).fetchall()
        else:
            rows = self.conn.execute(
                """SELECT brand, object_type, object_id, object_name, daily_budget_usd
                   FROM meta_active_budgets
                   WHERE is_active = 1
                   ORDER BY daily_budget_usd DESC""",
            ).fetchall()
        return [dict(r) for r in rows] if rows else []

    def _combo_perf_hint(self, object_id: str) -> dict[str, Any] | None:
        """Map a Meta object to combo performance data (best-effort)."""
        if not self.combo_store:
            return None
        try:
            return self.combo_store.get_perf_by_meta_object(object_id)
        except Exception:
            return None

    # ── Plan generation ──

    def suggest_plan(
        self,
        *,
        brand: str,
        cap_usd: float,
        current_total_usd: float,
        delta_usd: float,
    ) -> ReallocationPlan:
        """Generate a reallocation plan to free budget for *delta_usd*.

        Uses global cap (all brands) unless per-brand caps are configured.
        """
        projected = current_total_usd + delta_usd
        required_free = max(0.0, projected - cap_usd)

        budgets = self._fetch_active_budgets(brand=None)  # global cap
        candidates = self._score_candidates(budgets)

        # Pick minimal set that frees required budget
        chosen: list[PauseCandidate] = []
        freed = 0.0
        for c in candidates:
            if freed >= required_free:
                break
            if c.daily_budget_usd <= 0:
                continue
            chosen.append(c)
            freed += c.daily_budget_usd

        now = datetime.now(UTC).isoformat()
        summary = [
            f"Required free budget: ${required_free:,.0f}/day",
            f"Suggested pause set frees: ${freed:,.0f}/day",
            "Note: This is a SAFE-MODE plan (no changes applied).",
        ]

        return ReallocationPlan(
            blocked_delta_usd=float(delta_usd),
            cap_usd=float(cap_usd),
            current_total_usd=float(current_total_usd),
            projected_total_usd=float(projected),
            required_free_usd=float(required_free),
            candidates=chosen,
            summary_lines=summary,
            meta={
                "generated_at": now,
                "confidence": self._overall_confidence(chosen),
                "brand": brand,
            },
        )

    def _score_candidates(
        self, budgets: list[dict[str, Any]]
    ) -> list[PauseCandidate]:
        """Score and rank all active budgets as potential pause candidates.

        Strongest reasons first (kill rule > no conversions > low ROAS > fallback).
        """
        candidates: list[PauseCandidate] = []

        for b in budgets:
            perf = self._combo_perf_hint(b["object_id"])
            reason = ""
            conf = "LOW"

            if perf:
                if perf.get("kill_reason"):
                    reason = f"Kill rule triggered: {perf['kill_reason']}"
                    conf = "HIGH"
                elif perf.get("conversions", 0) == 0 and perf.get("spend_usd", 0) > 20:
                    reason = "No conversions with meaningful spend"
                    conf = "MED"
                elif perf.get("roas", 0) < 0.8 and perf.get("spend_usd", 0) > 30:
                    reason = "Low ROAS with meaningful spend"
                    conf = "MED"

            if not reason:
                reason = "Largest budget candidate (no performance data bound)"
                conf = "LOW"

            candidates.append(
                PauseCandidate(
                    object_type=b["object_type"],
                    object_id=b["object_id"],
                    object_name=b["object_name"],
                    daily_budget_usd=float(b["daily_budget_usd"] or 0),
                    reason=reason,
                    confidence=conf,
                )
            )

        # Sort: HIGH confidence first, then by budget descending
        conf_order = {"HIGH": 0, "MED": 1, "LOW": 2}
        candidates.sort(
            key=lambda c: (conf_order.get(c.confidence, 3), -c.daily_budget_usd)
        )
        return candidates

    def _overall_confidence(self, chosen: list[PauseCandidate]) -> str:
        if not chosen:
            return "LOW"
        if any(c.confidence == "HIGH" for c in chosen):
            return "MED" if any(c.confidence == "LOW" for c in chosen) else "HIGH"
        if any(c.confidence == "MED" for c in chosen):
            return "MED"
        return "LOW"


# ── Plan executor (safe-mode default) ──


def execute_reallocation_plan(
    conn: sqlite3.Connection,
    plan: ReallocationPlan,
    *,
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Execute (or simulate) a reallocation plan.

    Parameters
    ----------
    conn : sqlite3.Connection
        Database connection with ``meta_active_budgets`` and ``audit_log``.
    plan : ReallocationPlan
        The plan to apply.
    safe_mode : bool
        When *True* (default), simulates pausing and writes audit log only.
        When *False*, deactivates budgets in ``meta_active_budgets``.
    correlation_id : str
        Correlation ID for audit trail.

    Returns a summary dict with applied/simulated status per candidate.
    """
    from packages.common.audit import write_audit

    results: list[dict[str, Any]] = []
    now = datetime.now(UTC).isoformat()

    for c in plan.candidates:
        entry: dict[str, Any] = {
            "object_type": c.object_type,
            "object_id": c.object_id,
            "object_name": c.object_name,
            "daily_budget_usd": c.daily_budget_usd,
            "reason": c.reason,
            "confidence": c.confidence,
        }

        if safe_mode:
            entry["action"] = "simulated_pause"
        else:
            # Deactivate in DB
            conn.execute(
                """UPDATE meta_active_budgets
                   SET is_active = 0, updated_at = ?
                   WHERE object_type = ? AND object_id = ?""",
                [now, c.object_type, c.object_id],
            )
            entry["action"] = "paused"

        results.append(entry)

    if not safe_mode:
        conn.commit()

    # Audit log
    write_audit(
        conn,
        action="reallocation_plan_executed",
        target="meta.apply_reallocation_plan",
        payload={
            "safe_mode": safe_mode,
            "candidates_count": len(plan.candidates),
            "required_free_usd": plan.required_free_usd,
            "cap_usd": plan.cap_usd,
            "results": results,
        },
        correlation_id=correlation_id,
    )

    freed = sum(c.daily_budget_usd for c in plan.candidates)
    return {
        "safe_mode": safe_mode,
        "candidates_processed": len(results),
        "freed_usd": freed,
        "results": results,
    }
