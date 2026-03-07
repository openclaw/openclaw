"""Widget content renderers — build Notion block arrays for each Command Center widget.

Each render function takes a data dict and returns a list of Notion blocks.
Blocks use the page_blocks factory functions for consistency.

UX rules enforced:
- Simple title (H2)
- One-sentence instruction (paragraph, gray)
- Data blocks (callout panels, bulleted lists)
- "What should I do?" line
- If data is missing, show repair instructions (never blank)
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.mirror.page_blocks import (
    bulleted_list_item,
    callout,
    divider,
    heading_2,
    paragraph,
)
from packages.agencyu.notion.widgets.widget_registry import WidgetSpec
from packages.common.clock import utc_now_iso

# ─────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────


def _status_emoji(status: str) -> str:
    """Map status to simple emoji."""
    return {
        "on_track": "\u2705",
        "healthy": "\u2705",
        "watch": "\u26a0\ufe0f",
        "off_track": "\u274c",
        "at_risk": "\u274c",
        "missing": "\u2753",
    }.get(status, "\u2796")


def _repair_block(spec: WidgetSpec, missing_keys: list[str]) -> list[dict[str, Any]]:
    """Build a repair-instructions block when required views are missing."""
    lines = [f"Missing: {k}" for k in missing_keys]
    repair_text = (
        f"This widget needs repair.\n"
        + "\n".join(lines)
        + "\n\nOpen Ops Console > Views Registry and create the missing views."
    )
    return [
        heading_2(f"\U0001f527 {spec.title} (Needs Setup)"),
        callout(repair_text, icon="warning", color="red_background"),
    ]


def _locked_banner() -> list[dict[str, Any]]:
    """Big locked banner when write_lock is active."""
    return [
        callout(
            "\U0001f512 System is LOCKED. No writes will be made. "
            "Disable write_lock in System Settings to enable changes.",
            icon="lock",
            color="red_background",
        ),
    ]


# ─────────────────────────────────────────
# Executive Strip — KPI row + status pills
# ─────────────────────────────────────────


def render_executive_strip(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render the executive strip: key KPIs at a glance.

    Expected data keys:
        active_clients (int), pipeline_calls_7d (int), pipeline_showed_7d (int),
        close_rate_7d (float), revenue_7d (float), open_invoices (int),
        overdue_tasks (int), system_status (str)
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2(f"{spec.icon} {spec.title}"))
    blocks.append(paragraph(spec.instruction, color="gray"))

    ac = data.get("active_clients", 0)
    calls = data.get("pipeline_calls_7d", 0)
    showed = data.get("pipeline_showed_7d", 0)
    close_rate = data.get("close_rate_7d", 0.0)
    rev = data.get("revenue_7d", 0.0)
    open_inv = data.get("open_invoices", 0)
    overdue = data.get("overdue_tasks", 0)
    sys_status = data.get("system_status", "unknown")

    kpi_text = (
        f"Active Clients: {ac}  |  "
        f"Calls Booked (7d): {calls}  |  "
        f"Calls Showed (7d): {showed}  |  "
        f"Close Rate: {close_rate:.0%}\n"
        f"Money In (7d): ${rev:,.0f}  |  "
        f"Open Invoices: {open_inv}  |  "
        f"Overdue Tasks: {overdue}  |  "
        f"Systems: {_status_emoji(sys_status)} {sys_status}"
    )
    blocks.append(callout(kpi_text, icon=spec.icon, color="blue_background"))
    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks


# ─────────────────────────────────────────
# Active Combos — client outcomes dashboard
# ─────────────────────────────────────────


def render_active_combos(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render active client outcomes table.

    Expected data keys:
        combos: list[{client, outcome, status, target, current}]
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2(f"{spec.icon} {spec.title}"))
    blocks.append(paragraph(spec.instruction, color="gray"))

    combos = data.get("combos", [])
    if not combos:
        blocks.append(callout("No active outcomes found.", icon="info", color="gray_background"))
        return blocks

    for c in combos[:20]:  # Cap at 20 for readability
        status = c.get("status", "unknown")
        emoji = _status_emoji(status)
        line = f"{emoji} {c.get('client', '?')} — {c.get('outcome', '?')} ({status})"
        if c.get("target") and c.get("current") is not None:
            line += f"  [{c['current']}/{c['target']}]"
        blocks.append(bulleted_list_item(line))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks


# ─────────────────────────────────────────
# Pipeline Quality — calls / closes / rates
# ─────────────────────────────────────────


def render_pipeline_quality(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render pipeline quality metrics.

    Expected data keys:
        calls_booked_7d, calls_showed_7d, no_shows_7d,
        close_rate_7d, show_rate_7d, avg_deal_value
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2(f"{spec.icon} {spec.title}"))
    blocks.append(paragraph(spec.instruction, color="gray"))

    booked = data.get("calls_booked_7d", 0)
    showed = data.get("calls_showed_7d", 0)
    no_shows = data.get("no_shows_7d", 0)
    close_rate = data.get("close_rate_7d", 0.0)
    show_rate = data.get("show_rate_7d", 0.0)
    avg_deal = data.get("avg_deal_value", 0.0)

    quality_text = (
        f"Calls Booked (7d): {booked}\n"
        f"Calls Showed (7d): {showed}  |  No-Shows: {no_shows}\n"
        f"Show Rate: {show_rate:.0%}  |  Close Rate: {close_rate:.0%}\n"
        f"Avg Deal Value: ${avg_deal:,.0f}"
    )

    # Color based on show rate
    color = "green_background" if show_rate >= 0.7 else (
        "yellow_background" if show_rate >= 0.5 else "red_background"
    )
    blocks.append(callout(quality_text, icon=spec.icon, color=color))

    # What should I do?
    if show_rate < 0.5:
        blocks.append(paragraph(
            "What should I do? Show rate is low. Check reminder sequences and setter follow-up.",
            color="gray",
        ))
    elif close_rate < 0.2:
        blocks.append(paragraph(
            "What should I do? Close rate needs attention. Review call scripts and offer positioning.",
            color="gray",
        ))
    else:
        blocks.append(paragraph(
            "What should I do? Pipeline looks healthy. Keep booking.",
            color="gray",
        ))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks


# ─────────────────────────────────────────
# Fulfillment Watchlist — overdue + stuck tasks
# ─────────────────────────────────────────


def render_fulfillment_watchlist(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render fulfillment watchlist.

    Expected data keys:
        overdue_tasks: list[{title, client, due, status}]
        stuck_tasks: list[{title, client, status, days_stuck}]
        tasks_due_today: int
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2(f"{spec.icon} {spec.title}"))
    blocks.append(paragraph(spec.instruction, color="gray"))

    overdue = data.get("overdue_tasks", [])
    stuck = data.get("stuck_tasks", [])
    due_today = data.get("tasks_due_today", 0)

    summary = f"Due Today: {due_today}  |  Overdue: {len(overdue)}  |  Stuck: {len(stuck)}"
    color = "green_background" if not overdue and not stuck else (
        "yellow_background" if len(overdue) <= 3 else "red_background"
    )
    blocks.append(callout(summary, icon=spec.icon, color=color))

    if overdue:
        blocks.append(paragraph("Overdue:", color="default"))
        for t in overdue[:10]:
            blocks.append(bulleted_list_item(
                f"\u274c {t.get('title', '?')} ({t.get('client', '?')}) — due {t.get('due', '?')}"
            ))

    if stuck:
        blocks.append(paragraph("Stuck (no progress):", color="default"))
        for t in stuck[:10]:
            blocks.append(bulleted_list_item(
                f"\u26a0\ufe0f {t.get('title', '?')} ({t.get('client', '?')}) — "
                f"{t.get('days_stuck', '?')} days"
            ))

    if not overdue and not stuck:
        blocks.append(paragraph(
            "What should I do? All clear! Nothing overdue or stuck.", color="gray"
        ))
    else:
        blocks.append(paragraph(
            "What should I do? Unblock stuck items first, then tackle overdue.",
            color="gray",
        ))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks


# ─────────────────────────────────────────
# Finance Snapshot — money in / money out
# ─────────────────────────────────────────


def render_finance_snapshot(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render finance snapshot.

    Expected data keys:
        revenue_7d, revenue_30d, expenses_30d, open_invoices_count,
        open_invoices_total, overdue_invoices_count, mrr
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2(f"{spec.icon} {spec.title}"))
    blocks.append(paragraph(spec.instruction, color="gray"))

    rev_7d = data.get("revenue_7d", 0.0)
    rev_30d = data.get("revenue_30d", 0.0)
    exp_30d = data.get("expenses_30d", 0.0)
    open_count = data.get("open_invoices_count", 0)
    open_total = data.get("open_invoices_total", 0.0)
    overdue = data.get("overdue_invoices_count", 0)
    mrr = data.get("mrr", 0.0)

    finance_text = (
        f"Money In (7d): ${rev_7d:,.0f}  |  Money In (30d): ${rev_30d:,.0f}\n"
        f"Money Out (30d): ${exp_30d:,.0f}  |  MRR: ${mrr:,.0f}\n"
        f"Open Invoices: {open_count} (${open_total:,.0f})  |  Overdue: {overdue}"
    )

    color = "green_background" if overdue == 0 else "red_background"
    blocks.append(callout(finance_text, icon=spec.icon, color=color))

    if overdue > 0:
        blocks.append(paragraph(
            "What should I do? Follow up on overdue invoices. Check Stripe for failed payments.",
            color="gray",
        ))
    else:
        blocks.append(paragraph(
            "What should I do? Finances look good. Review expenses if needed.",
            color="gray",
        ))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks


# ─────────────────────────────────────────
# Systems Reliability — drift, heals, audit
# ─────────────────────────────────────────


def render_systems_reliability(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render systems reliability dashboard.

    Expected data keys:
        drift_issues (int), last_heal_ts (str), last_verified_ts (str),
        audit_errors_24h (int), write_lock (bool), safe_mode (bool),
        queue_depth (int), cooldown_active (bool),
        integrations_mode (str)
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2(f"{spec.icon} {spec.title}"))
    blocks.append(paragraph(spec.instruction, color="gray"))

    drift = data.get("drift_issues", 0)
    last_heal = data.get("last_heal_ts", "never")
    last_verified = data.get("last_verified_ts", "never")
    errors_24h = data.get("audit_errors_24h", 0)
    write_lock = data.get("write_lock", False)
    safe_mode = data.get("safe_mode", True)
    queue = data.get("queue_depth", 0)
    cooldown = data.get("cooldown_active", False)
    int_mode = data.get("integrations_mode", "clawdcursor_preferred")

    # Status determination
    has_issues = drift > 0 or errors_24h > 0 or cooldown
    overall = "healthy" if not has_issues else ("watch" if drift <= 3 else "at_risk")

    status_lines = [
        f"{_status_emoji(overall)} Overall: {overall}",
        f"Drift Issues: {drift}  |  Last Heal: {last_heal}",
        f"Last Verified: {last_verified}  |  Audit Errors (24h): {errors_24h}",
        f"Queue Depth: {queue}  |  Cooldown: {'active' if cooldown else 'off'}",
        f"Write Lock: {'ON' if write_lock else 'off'}  |  Safe Mode: {'ON' if safe_mode else 'off'}",
        f"Integration Mode: {int_mode}",
    ]

    color = "green_background" if overall == "healthy" else (
        "yellow_background" if overall == "watch" else "red_background"
    )
    blocks.append(callout("\n".join(status_lines), icon=spec.icon, color=color))

    if write_lock:
        blocks.append(callout(
            "\U0001f512 LOCKED — No writes will be made until write_lock is disabled.",
            icon="lock",
            color="red_background",
        ))

    if has_issues:
        blocks.append(paragraph(
            "What should I do? Open Ops Console for details. Run drift heal if needed.",
            color="gray",
        ))
    else:
        blocks.append(paragraph(
            "What should I do? All systems green. No action needed.",
            color="gray",
        ))

    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks


# ─────────────────────────────────────────
# Renderer dispatch
# ─────────────────────────────────────────

def render_fix_list_widget(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render the fix list widget via cc_fix_list module.

    Expected data keys:
        compliance_result: ComplianceResult dict (from to_dict())
    """
    from packages.agencyu.notion.widgets.cc_fix_list import render_fix_list_blocks
    from packages.agencyu.notion.compliance_models import ComplianceResult, MissingProperty, MissingViewKey

    cr_dict = data.get("compliance_result", {})
    if not cr_dict:
        return render_fix_list(cr_dict)

    # Reconstruct ComplianceResult from dict
    result = ComplianceResult(
        compliant=cr_dict.get("compliant", True),
        template_version=cr_dict.get("template_version", ""),
        os_version=cr_dict.get("os_version", ""),
        missing_pages=cr_dict.get("missing_pages", []),
        missing_db_keys=cr_dict.get("missing_db_keys", []),
        missing_db_properties=[
            MissingProperty(
                db_key=p.get("db_key", ""),
                property_key=p.get("property_key", ""),
                expected_type=p.get("expected_type", ""),
                actual_type=p.get("actual_type", ""),
            )
            for p in cr_dict.get("missing_db_properties", [])
        ],
        missing_view_keys=[
            MissingViewKey(
                view_key=v.get("view_key", ""),
                db_key=v.get("db_key", ""),
            )
            for v in cr_dict.get("missing_view_keys", [])
        ],
        missing_widgets=cr_dict.get("missing_widgets", []),
        missing_portal_sections=cr_dict.get("missing_portal_sections", []),
    )
    return render_fix_list_blocks(result)


def render_skills_recommendations_widget(
    data: dict[str, Any], spec: WidgetSpec
) -> list[dict[str, Any]]:
    """Render the skills recommendations widget via cc_skills_recommendations module.

    Expected data keys:
        scout_report: ScoutReport.to_dict() output
    """
    from packages.agencyu.notion.widgets.cc_skills_recommendations import (
        render_skills_recommendations,
    )
    from packages.agencyu.skills.models import ScoutReport, SkillCandidate

    report_dict = data.get("scout_report", {})
    if not report_dict:
        # No report data — render empty state
        return [
            heading_2("Skills to Fork (Recommended)"),
            callout(
                "No skills scan has been run yet. "
                "Run POST /admin/skills/scan to discover candidates.",
                icon="info",
                color="gray_background",
            ),
        ]

    # Reconstruct ScoutReport from dict
    candidates = []
    for cd in report_dict.get("candidates", []):
        candidates.append(SkillCandidate(
            skill_key=cd.get("skill_key", ""),
            title=cd.get("title", ""),
            description=cd.get("description", ""),
            source_key=cd.get("source_key", ""),
            source_url=cd.get("source_url", ""),
            trust_tier=cd.get("trust_tier", "unknown"),
            fit_score=cd.get("fit_score", 0.0),
            risk_score=cd.get("risk_score", 0.0),
            recommended_mode=cd.get("recommended_mode", "confirm_only"),
        ))

    report = ScoutReport(
        generated_at=report_dict.get("generated_at", ""),
        candidates=candidates,
        top_full_digital=report_dict.get("top_full_digital", []),
        top_cutmv=report_dict.get("top_cutmv", []),
        do_not_install=report_dict.get("do_not_install", []),
    )
    return render_skills_recommendations(report)


def render_db_registry_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render the DB Registry widget from a data dict.

    Expected data keys:
    - db_root_page_url: str | None
    - skills_backlog: dict with exists, compliant, db_url, missing_props_count, missing_options_count
    """
    from packages.agencyu.notion.widgets.cc_db_registry import render_db_registry

    return render_db_registry(
        db_root_page_url=data.get("db_root_page_url"),
        skills_backlog=data.get("skills_backlog", {"exists": False}),
    )


def render_cc_kpis_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render cc.kpis widget — Today KPI strip."""
    from packages.agencyu.notion.widgets.cc_kpis import render_cc_kpis
    return render_cc_kpis(data)


def render_cc_pipeline_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render cc.pipeline widget — Pipeline stage counts."""
    from packages.agencyu.notion.widgets.cc_pipeline import render_cc_pipeline
    return render_cc_pipeline(data)


def render_cc_cash_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render cc.cash widget — Cash & Profit."""
    from packages.agencyu.notion.widgets.cc_cash import render_cc_cash
    return render_cc_cash(data)


def render_cc_calendar_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render cc.calendar widget — Today's meetings."""
    from packages.agencyu.notion.widgets.cc_calendar import render_cc_calendar
    return render_cc_calendar(data)


def render_cc_alerts_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render cc.alerts widget — System and business alerts."""
    from packages.agencyu.notion.widgets.cc_alerts import render_cc_alerts
    return render_cc_alerts(data)


def render_cc_projects_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render cc.projects widget — Active Work summary."""
    from packages.agencyu.notion.widgets.cc_projects import render_cc_projects
    return render_cc_projects(data)


def render_cc_quick_actions_widget(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render cc.quick_actions widget — Quick action links."""
    from packages.agencyu.notion.widgets.cc_quick_actions import render_cc_quick_actions
    return render_cc_quick_actions(data)


def render_cc_brand_section(
    data: dict[str, Any],
    spec: WidgetSpec,
) -> list[dict[str, Any]]:
    """Render a brand-section widget (cc.global, cc.fd, cc.cutmv).

    Shows filtered KPIs, pipeline, cash, delivery, and webops for one brand
    (or combined for global). Uses linked database embeds where views exist,
    falls back to summary text.
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2(f"{spec.icon} {spec.title}"))
    blocks.append(paragraph(spec.instruction, color="gray"))

    # Extract brand_key from widget_key: cc.fd -> fd, cc.cutmv -> cutmv, cc.global -> global
    brand_key = spec.widget_key.split(".")[-1] if "." in spec.widget_key else "global"
    brand_label = {"fd": "Full Digital", "cutmv": "CUTMV", "global": "All Brands"}.get(
        brand_key, brand_key.upper(),
    )

    sections = [
        ("kpis", "KPIs", "\U0001f4ca"),
        ("pipeline", "Pipeline", "\U0001f4de"),
        ("cash", "Cash", "\U0001f4b0"),
        ("delivery", "Delivery", "\U0001f4cb"),
        ("webops", "WebOps", "\u2699\ufe0f"),
    ]

    brand_data = data.get("brands", {}).get(brand_key, {})

    for section_key, label, icon in sections:
        view_key = f"cc.{brand_key}.{section_key}"
        section_data = brand_data.get(section_key, {})
        if section_data:
            summary = section_data.get("summary", f"{label}: see database view")
            blocks.append(bulleted_list_item(f"{icon} {label} ({brand_label}): {summary}"))
        else:
            blocks.append(bulleted_list_item(
                f"{icon} {label} ({brand_label}): No data yet. "
                f"Ensure view '{view_key}' exists in Views Registry.",
            ))

    blocks.append(divider())
    blocks.append(paragraph(f"Updated: {utc_now_iso()}", color="gray"))
    return blocks


RENDERER_MAP: dict[str, Any] = {
    "render_executive_strip": render_executive_strip,
    "render_active_combos": render_active_combos,
    "render_pipeline_quality": render_pipeline_quality,
    "render_fulfillment_watchlist": render_fulfillment_watchlist,
    "render_finance_snapshot": render_finance_snapshot,
    "render_systems_reliability": render_systems_reliability,
    "render_fix_list_widget": render_fix_list_widget,
    "render_skills_recommendations_widget": render_skills_recommendations_widget,
    "render_db_registry_widget": render_db_registry_widget,
    "render_cc_kpis_widget": render_cc_kpis_widget,
    "render_cc_pipeline_widget": render_cc_pipeline_widget,
    "render_cc_cash_widget": render_cc_cash_widget,
    "render_cc_calendar_widget": render_cc_calendar_widget,
    "render_cc_alerts_widget": render_cc_alerts_widget,
    "render_cc_projects_widget": render_cc_projects_widget,
    "render_cc_quick_actions_widget": render_cc_quick_actions_widget,
    "render_cc_brand_section": render_cc_brand_section,
}


def render_widget(
    spec: WidgetSpec,
    data: dict[str, Any],
    available_view_keys: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Dispatch to the correct renderer for a widget spec.

    If required views are missing, returns repair instructions instead.
    """
    # Check view dependencies
    if available_view_keys is not None:
        missing = [k for k in spec.required_view_keys if k not in available_view_keys]
        if missing:
            return _repair_block(spec, missing)

    renderer_fn = RENDERER_MAP.get(spec.renderer)
    if not renderer_fn:
        return [callout(
            f"Widget '{spec.widget_key}' has no renderer '{spec.renderer}'.",
            icon="warning", color="red_background",
        )]

    return renderer_fn(data, spec)


# ─────────────────────────────────────────
# Fix List — compliance-driven repair widget
# ─────────────────────────────────────────


def render_fix_list(
    compliance_result: dict[str, Any],
) -> list[dict[str, Any]]:
    """Render a Fix List widget from a ComplianceResult.to_dict().

    Shows missing items grouped by category with repair instructions.
    Designed for the "5-year-old standard" — simple, actionable, no jargon.
    """
    blocks: list[dict[str, Any]] = []
    blocks.append(heading_2("\U0001f527 Fix List"))

    missing_pages = compliance_result.get("missing_pages", [])
    missing_dbs = compliance_result.get("missing_db_keys", [])
    missing_props = compliance_result.get("missing_db_properties", [])
    missing_views = compliance_result.get("missing_view_keys", [])
    missing_widgets = compliance_result.get("missing_widgets", [])
    missing_sections = compliance_result.get("missing_portal_sections", [])

    total = (
        len(missing_pages) + len(missing_dbs) + len(missing_props)
        + len(missing_views) + len(missing_widgets) + len(missing_sections)
    )

    if total == 0:
        blocks.append(callout(
            "\u2705 Everything looks good! No fixes needed.",
            icon="check", color="green_background",
        ))
        blocks.append(paragraph(f"Checked: {utc_now_iso()}", color="gray"))
        return blocks

    blocks.append(paragraph(
        f"There are {total} items that need fixing. Work through them in order.",
        color="gray",
    ))

    item_num = 0

    if missing_pages:
        blocks.append(callout(
            f"\U0001f4c4 Missing Pages ({len(missing_pages)})\n"
            + "\n".join(f"  - {p}" for p in missing_pages)
            + "\n\nWhat should I do? Create these pages in Notion under the root workspace.",
            icon="warning", color="red_background",
        ))
        item_num += len(missing_pages)

    if missing_dbs:
        blocks.append(callout(
            f"\U0001f5c4 Missing Databases ({len(missing_dbs)})\n"
            + "\n".join(f"  - {d}" for d in missing_dbs)
            + "\n\nWhat should I do? Run the setup wizard or create these databases manually.",
            icon="warning", color="red_background",
        ))
        item_num += len(missing_dbs)

    if missing_props:
        grouped: dict[str, list[str]] = {}
        for p in missing_props:
            db_key = p.get("db_key", "?")
            pk = p.get("property_key", "?")
            et = p.get("expected_type", "?")
            grouped.setdefault(db_key, []).append(f"{pk} ({et})")
        for db_key, props in grouped.items():
            blocks.append(callout(
                f"\U0001f50d {db_key}: Missing Properties ({len(props)})\n"
                + "\n".join(f"  - {p}" for p in props)
                + "\n\nWhat should I do? Add these properties to the database in Notion.",
                icon="warning", color="yellow_background",
            ))
        item_num += len(missing_props)

    if missing_views:
        view_lines = []
        for v in missing_views:
            if isinstance(v, dict):
                view_lines.append(f"  - {v.get('view_key', '?')} (for {v.get('db_key', '?')})")
            else:
                view_lines.append(f"  - {v}")
        blocks.append(callout(
            f"\U0001f4ca Missing Views ({len(missing_views)})\n"
            + "\n".join(view_lines)
            + "\n\nWhat should I do? Add these as rows in the Views Registry database.",
            icon="warning", color="yellow_background",
        ))
        item_num += len(missing_views)

    if missing_widgets:
        blocks.append(callout(
            f"\U0001f9e9 Missing Widgets ({len(missing_widgets)})\n"
            + "\n".join(f"  - {w}" for w in missing_widgets)
            + "\n\nWhat should I do? Run the widget writer to create marker blocks on Command Center.",
            icon="warning", color="yellow_background",
        ))
        item_num += len(missing_widgets)

    if missing_sections:
        blocks.append(callout(
            f"\U0001f4d1 Missing Portal Sections ({len(missing_sections)})\n"
            + "\n".join(f"  - {s}" for s in missing_sections)
            + "\n\nWhat should I do? Run the portal healer to create section blocks.",
            icon="warning", color="yellow_background",
        ))
        item_num += len(missing_sections)

    # Run Repair link
    blocks.append(divider())
    blocks.append(paragraph(
        "\U0001f680 To auto-fix: POST /admin/reconcile/heal (requires admin token)",
        color="gray",
    ))
    blocks.append(paragraph(f"Checked: {utc_now_iso()}", color="gray"))

    return blocks
