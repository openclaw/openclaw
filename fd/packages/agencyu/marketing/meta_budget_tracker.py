"""Meta Budget Tracker — computes current daily spend ceiling and cap utilisation.

V1 (shipped now):
    Budget-based "spend ceiling" — sums daily budgets across active campaigns/adsets
    stored in ``meta_active_budgets``.  Fast, deterministic, safe.

V2 (later):
    Swap ``compute_current_daily_budget_usd`` to pull actual spend from the
    Meta Insights API.  The ``MetaBudgetSnapshot`` interface stays the same so
    approval-card code never changes.

Usage::

    tracker = MetaBudgetTracker(conn, policy)
    snap = tracker.snapshot(brand="fulldigital")
    # pass snap into approval_card_text(…, meta_budget_snapshot=snap)
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_EXPERIMENT_POLICY_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "experiment_policy.yaml"
)


def _load_meta_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the ``meta`` block from experiment policy."""
    if policy is not None:
        return policy.get("meta", {})
    try:
        import yaml

        data = yaml.safe_load(_EXPERIMENT_POLICY_PATH.read_text()) or {}
        return data.get("meta", {})
    except Exception:
        return {}


@dataclass
class MetaBudgetSnapshot:
    """Point-in-time budget utilisation snapshot."""

    total_daily_budget_usd: float
    cap_usd: float
    cap_used_ratio: float
    soft_warning_ratio: float
    soft_warning_active: bool
    computed_at: str
    source: str  # "budgets" (v1) or "insights" (v2)


class MetaBudgetTracker:
    """Compute current Meta daily budget utilisation against the configured cap.

    Parameters
    ----------
    conn : sqlite3.Connection
        Database connection with ``meta_active_budgets`` table.
    policy : dict | None
        Full experiment policy dict.  When *None*, reads from YAML on disk.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        policy: dict[str, Any] | None = None,
    ) -> None:
        self.conn = conn
        self._meta = _load_meta_policy(policy)

    def get_daily_budget_cap(self) -> float:
        return float(self._meta.get("max_daily_budget_cap_usd", 200))

    def get_soft_warning_ratio(self) -> float:
        return float(self._meta.get("soft_warning_ratio", 0.75))

    # ── V1: budget-based spend ceiling ──

    def compute_current_daily_budget_usd(
        self,
        brand: str | None = None,
    ) -> float:
        """Sum active daily budgets from ``meta_active_budgets``."""
        try:
            if brand:
                row = self.conn.execute(
                    """SELECT COALESCE(SUM(daily_budget_usd), 0) AS total
                       FROM meta_active_budgets
                       WHERE is_active = 1 AND brand = ?""",
                    [brand],
                ).fetchone()
            else:
                row = self.conn.execute(
                    """SELECT COALESCE(SUM(daily_budget_usd), 0) AS total
                       FROM meta_active_budgets
                       WHERE is_active = 1""",
                ).fetchone()
            return float(row["total"]) if row else 0.0
        except Exception:
            return 0.0

    # ── Snapshot (card-friendly) ──

    def snapshot(self, brand: str | None = None) -> MetaBudgetSnapshot:
        cap = self.get_daily_budget_cap()
        soft = self.get_soft_warning_ratio()
        total = self.compute_current_daily_budget_usd(brand=brand)
        ratio = (total / cap) if cap > 0 else 0.0
        now = datetime.now(UTC).isoformat()

        return MetaBudgetSnapshot(
            total_daily_budget_usd=total,
            cap_usd=cap,
            cap_used_ratio=ratio,
            soft_warning_ratio=soft,
            soft_warning_active=(ratio >= soft),
            computed_at=now,
            source="budgets",
        )

    # ── Enforcement helpers ──

    def check_projected_total(
        self,
        delta_usd: float,
        brand: str | None = None,
    ) -> MetaBudgetSnapshot:
        """Return a snapshot that includes *delta_usd* in the total.

        Use before executing a budget increase to see if the projected total
        would exceed the cap or trigger the soft warning.
        """
        snap = self.snapshot(brand=brand)
        projected = snap.total_daily_budget_usd + delta_usd
        cap = snap.cap_usd
        ratio = (projected / cap) if cap > 0 else 0.0
        return MetaBudgetSnapshot(
            total_daily_budget_usd=projected,
            cap_usd=cap,
            cap_used_ratio=ratio,
            soft_warning_ratio=snap.soft_warning_ratio,
            soft_warning_active=(ratio >= snap.soft_warning_ratio),
            computed_at=snap.computed_at,
            source=snap.source,
        )

    def enforce_cap(self, delta_usd: float, brand: str | None = None) -> None:
        """Raise ``ValueError`` if adding *delta_usd* would exceed the cap."""
        projected = self.check_projected_total(delta_usd, brand=brand)
        if projected.cap_used_ratio > 1.0:
            raise ValueError(
                f"Projected total ${projected.total_daily_budget_usd:.0f}/day "
                f"exceeds cap ${projected.cap_usd:.0f}/day"
            )

    def escalate_risk_level(
        self,
        current_risk: str,
        delta_usd: float,
        brand: str | None = None,
    ) -> str:
        """Escalate risk level if projected total >= soft warning threshold."""
        projected = self.check_projected_total(delta_usd, brand=brand)
        if projected.soft_warning_active:
            if current_risk == "low":
                return "medium"
            if current_risk == "medium":
                return "high"
        return current_risk

    # ── Budget persistence (upsert) ──

    def upsert_budget(
        self,
        brand: str,
        object_type: str,
        object_id: str,
        object_name: str,
        daily_budget_usd: float,
        is_active: bool = True,
    ) -> None:
        """Insert or update a budget record in ``meta_active_budgets``."""
        now = datetime.now(UTC).isoformat()
        self.conn.execute(
            """INSERT INTO meta_active_budgets
                   (brand, object_type, object_id, object_name,
                    daily_budget_usd, is_active, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(object_type, object_id) DO UPDATE SET
                   daily_budget_usd = excluded.daily_budget_usd,
                   is_active = excluded.is_active,
                   updated_at = excluded.updated_at""",
            [brand, object_type, object_id, object_name,
             daily_budget_usd, 1 if is_active else 0, now],
        )
        self.conn.commit()

    def deactivate_budget(self, object_type: str, object_id: str) -> None:
        """Mark a budget record inactive (paused / killed)."""
        now = datetime.now(UTC).isoformat()
        self.conn.execute(
            """UPDATE meta_active_budgets
               SET is_active = 0, updated_at = ?
               WHERE object_type = ? AND object_id = ?""",
            [now, object_type, object_id],
        )
        self.conn.commit()
