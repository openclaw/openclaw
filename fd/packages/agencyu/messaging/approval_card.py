"""Approval Card renderer — Telegram-friendly formatted approval messages.

Renders brand chips, risk chips, spend impact, and full approval context
into a plain-text card suitable for Telegram messages.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from packages.agencyu.marketing.alternative_scaling import AlternativeScalingPlan
    from packages.agencyu.marketing.budget_reallocation import ReallocationPlan
    from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetSnapshot

_EXPERIMENT_POLICY_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "experiment_policy.yaml"
)


def get_meta_daily_cap(policy_path: Path | None = None) -> float | None:
    """Read meta.max_daily_budget_cap_usd from experiment policy.

    Returns the configured cap, or ``None`` when the policy file is missing
    or the key is absent.
    """
    import yaml  # lazy import — pyyaml may not be in every test env

    p = policy_path or _EXPERIMENT_POLICY_PATH
    try:
        data: dict[str, Any] = yaml.safe_load(p.read_text()) or {}
        return data.get("meta", {}).get("max_daily_budget_cap_usd")
    except Exception:
        return None


def get_meta_soft_warning_ratio(policy_path: Path | None = None) -> float:
    """Read meta.soft_warning_ratio from experiment policy (default 0.75)."""
    import yaml

    p = policy_path or _EXPERIMENT_POLICY_PATH
    try:
        data: dict[str, Any] = yaml.safe_load(p.read_text()) or {}
        return float(data.get("meta", {}).get("soft_warning_ratio", 0.75))
    except Exception:
        return 0.75


def brand_chip(brand: str) -> str:
    """Return a branded chip string for Telegram display."""
    if brand == "fulldigital":
        return "\U0001f7e9 FULL DIGITAL"
    if brand == "cutmv":
        return "\U0001f7e6 CUTMV"
    return f"\u2b1c {brand.upper()}"


def risk_chip(risk_level: str) -> str:
    """Return a risk-level chip string for Telegram display."""
    rl = (risk_level or "").lower()
    if rl == "low":
        return "\U0001f7e2 LOW"
    if rl == "medium":
        return "\U0001f7e1 MEDIUM"
    return "\U0001f534 HIGH"


def fmt_usd(x: float) -> str:
    """Format a dollar amount."""
    try:
        return f"${x:,.0f}"
    except Exception:
        return f"${x}"


def fmt_pct(x: float) -> str:
    """Format a ratio as a percentage string."""
    try:
        return f"{x * 100:.0f}%"
    except Exception:
        return "0%"


def clamp_ratio(ratio: float) -> float:
    """Clamp a ratio to [0.0, ∞) — never negative."""
    return max(0.0, ratio)


def projected_status(projected_ratio: float, soft_warning_ratio: float) -> str:
    """Return a status tag for the projected cap utilisation."""
    if projected_ratio > 1.0:
        return "\u2192 BLOCKED"
    if projected_ratio >= soft_warning_ratio:
        return "\u2192 \u26a0\ufe0f WARNING"
    return "\u2192 OK"


def meta_cap_section(
    action_type: str,
    meta_budget_snapshot: MetaBudgetSnapshot | None = None,
    max_daily_spend_hard_cap_usd: float | None = None,
    approval_delta_usd: float = 0.0,
) -> list[str]:
    """Build the Meta cap lines for an approval card.

    When a *meta_budget_snapshot* is provided, renders the full dynamic
    section (cap + today budget + % + soft warning).  Otherwise falls
    back to the static cap line from the previous implementation.
    """
    if not action_type.startswith("meta."):
        return []

    # ── Dynamic path: full snapshot available ──
    if meta_budget_snapshot is not None:
        snap = meta_budget_snapshot
        cap = fmt_usd(snap.cap_usd)
        total = fmt_usd(snap.total_daily_budget_usd)
        pct = fmt_pct(snap.cap_used_ratio)

        lines: list[str] = []
        lines.append(f"Max daily cap: {cap}/day (hard stop)")
        lines.append(f"Today budget: {total}/day of {cap}/day ({pct} of cap)")

        if snap.soft_warning_active:
            warn_pct = fmt_pct(snap.soft_warning_ratio)
            lines.append(f"\u26a0\ufe0f Soft warning: at/above {warn_pct} of cap")

        # Projected line (when a delta is provided)
        if approval_delta_usd != 0.0:
            projected_total = snap.total_daily_budget_usd + approval_delta_usd
            projected_ratio = clamp_ratio(
                (projected_total / snap.cap_usd) if snap.cap_usd > 0 else 0.0
            )
            status = projected_status(projected_ratio, snap.soft_warning_ratio)
            lines.append(
                f"Projected after this change: {fmt_usd(projected_total)}/day "
                f"of {cap}/day ({fmt_pct(projected_ratio)} of cap) {status}"
            )
        return lines

    # ── Static fallback: cap only ──
    effective_cap = max_daily_spend_hard_cap_usd
    if effective_cap is None:
        effective_cap = get_meta_daily_cap()

    if effective_cap is not None:
        return [f"Max daily cap: {fmt_usd(effective_cap)}/day (hard stop)"]

    return []


def check_projected_blocked(
    meta_budget_snapshot: MetaBudgetSnapshot | None,
    delta_usd: float,
) -> dict[str, Any]:
    """Check whether a projected budget change would be BLOCKED.

    Returns a dict with:
      blocked (bool), status (str), projected_total, projected_ratio,
      cap_usd, ratio_now, and the full audit-friendly payload.
    """
    if meta_budget_snapshot is None:
        return {"blocked": False, "status": "no_snapshot"}

    snap = meta_budget_snapshot
    projected_total = snap.total_daily_budget_usd + delta_usd
    projected_ratio = clamp_ratio(
        (projected_total / snap.cap_usd) if snap.cap_usd > 0 else 0.0
    )
    status = projected_status(projected_ratio, snap.soft_warning_ratio)
    blocked = projected_ratio > 1.0

    return {
        "blocked": blocked,
        "status": status,
        "cap_usd": snap.cap_usd,
        "total_now": snap.total_daily_budget_usd,
        "projected_total": projected_total,
        "ratio_now": snap.cap_used_ratio,
        "ratio_projected": projected_ratio,
        "soft_warning_ratio": snap.soft_warning_ratio,
        "source": snap.source,
    }


def approval_card_text(
    *,
    approval_id: str,
    action_type: str,
    brand: str,
    estimated_spend_impact_usd: float,
    risk_level: str,
    why_now: str,
    rollback_plan: str,
    expires_at: str,
    requires_two_step: bool,
    confirm_expires_at: str | None,
    correlation_id: str,
    max_daily_spend_hard_cap_usd: float | None = None,
    meta_budget_snapshot: MetaBudgetSnapshot | None = None,
) -> str:
    """Render a full approval card as plain text for Telegram."""
    spend_val = abs(float(estimated_spend_impact_usd or 0))
    spend = fmt_usd(spend_val)
    sign = "+" if (estimated_spend_impact_usd or 0) >= 0 else "-"
    spend_line = f"{sign}{spend}/day" if action_type.startswith("meta.") else f"{sign}{spend}"

    lines: list[str] = []
    lines.append(f"{brand_chip(brand)}  \u2022  Approval Needed")
    lines.append("")
    lines.append(f"Action: {action_type}")
    lines.append(f"Spend impact: {spend_line}")

    # Meta cap section (dynamic if snapshot available, static fallback otherwise)
    cap_lines = meta_cap_section(
        action_type,
        meta_budget_snapshot=meta_budget_snapshot,
        max_daily_spend_hard_cap_usd=max_daily_spend_hard_cap_usd,
        approval_delta_usd=float(estimated_spend_impact_usd or 0),
    )
    lines.extend(cap_lines)

    lines.append(f"Risk: {risk_chip(risk_level)}")

    lines.append("")
    lines.append("Why now:")
    lines.append(f"- {why_now}")
    lines.append("")
    lines.append("Rollback plan:")
    lines.append(f"- {rollback_plan}")
    lines.append("")
    lines.append(f"ID: {approval_id}")
    lines.append(f"Expires: {expires_at}")

    if requires_two_step and confirm_expires_at:
        lines.append(f"Confirm window: {confirm_expires_at}")
        lines.append("Note: This is a high-risk action and requires 2-step approval.")

    lines.append(f"Correlation: {correlation_id}")

    return "\n".join(lines)


def reallocation_plan_text(plan: ReallocationPlan) -> str:
    """Render a budget reallocation plan as plain text for Telegram."""
    lines: list[str] = []
    lines.append("Budget reallocation plan (suggested):")
    lines.extend(f"- {s}" for s in plan.summary_lines)
    lines.append("")

    if not plan.candidates:
        lines.append(
            "No pause candidates found. "
            "(Need Meta objects + budgets persisted.)"
        )
        return "\n".join(lines)

    lines.append("Pause candidates:")
    for i, c in enumerate(plan.candidates, 1):
        lines.append(f"{i}. Pause {c.object_type} \u2022 {c.object_name}")
        lines.append(
            f"   Frees: ${c.daily_budget_usd:,.0f}/day "
            f"\u2022 Confidence: {c.confidence}"
        )
        lines.append(f"   Reason: {c.reason}")

    conf = plan.meta.get("confidence", "LOW")
    lines.append("")
    lines.append(f"Overall confidence: {conf}")
    return "\n".join(lines)


def alternative_scaling_text(plan: AlternativeScalingPlan) -> str:
    """Render an alternative scaling plan as plain text for Telegram."""
    lines: list[str] = ["Alternative scaling option (suggested):"]
    lines.extend(f"- {s}" for s in plan.summary_lines)
    return "\n".join(lines)
