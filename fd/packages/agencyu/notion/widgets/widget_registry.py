"""Widget Registry — deterministic widget specs for the Notion Command Center.

Each WidgetSpec defines:
- A unique widget_key (e.g. "cc.executive_strip")
- Marker start/end tags for replace-between-markers placement
- Required view_keys that must exist in the Views Registry
- A render callable reference (string name → resolved at runtime)
- UX metadata (title, instruction, icon)

The registry is the single source of truth for what widgets the Command Center
should contain. The compliance verifier checks that all required widgets are
present and their view dependencies are satisfied.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.widget_registry")


@dataclass(frozen=True)
class WidgetSpec:
    """Deterministic spec for a Command Center widget."""

    widget_key: str
    title: str
    instruction: str  # One-sentence "what should I do?" guidance
    icon: str  # Emoji for callout panel
    renderer: str  # Name of render function in widget_renderers module
    required_view_keys: list[str] = field(default_factory=list)
    marker_key: str = ""  # Auto-derived from widget_key if empty

    @property
    def effective_marker_key(self) -> str:
        return self.marker_key or self.widget_key.upper().replace(".", "_")

    @property
    def marker_start(self) -> str:
        return f"[[OPENCLAW:{self.effective_marker_key}:START]]"

    @property
    def marker_end(self) -> str:
        return f"[[OPENCLAW:{self.effective_marker_key}:END]]"


# ─────────────────────────────────────────
# Canonical widget definitions
# ─────────────────────────────────────────

EXECUTIVE_STRIP = WidgetSpec(
    widget_key="cc.executive_strip",
    title="Today at a Glance",
    instruction="Check the numbers. Green = good. Yellow = watch. Red = fix now.",
    icon="\U0001f4ca",  # bar chart
    renderer="render_executive_strip",
    required_view_keys=["cc.active_combos", "cc.pipeline_quality", "cc.finance_snapshot"],
)

ACTIVE_COMBOS_TABLE = WidgetSpec(
    widget_key="cc.active_combos_table",
    title="Active Clients & Outcomes",
    instruction="Review each client's status. Tap any row to see details.",
    icon="\U0001f465",  # busts in silhouette
    renderer="render_active_combos",
    required_view_keys=["cc.active_combos"],
)

PIPELINE_QUALITY = WidgetSpec(
    widget_key="cc.pipeline_quality_panel",
    title="Pipeline Quality",
    instruction="Are enough calls showing? Is the close rate healthy?",
    icon="\U0001f4de",  # telephone
    renderer="render_pipeline_quality",
    required_view_keys=["cc.pipeline_quality", "meetings.showed_7d"],
)

FULFILLMENT_WATCHLIST = WidgetSpec(
    widget_key="cc.fulfillment_watchlist",
    title="Fulfillment Watchlist",
    instruction="Fix anything overdue. Unblock anything stuck.",
    icon="\U0001f4cb",  # clipboard
    renderer="render_fulfillment_watchlist",
    required_view_keys=["cc.fulfillment_watchlist", "tasks.today"],
)

FINANCE_SNAPSHOT = WidgetSpec(
    widget_key="cc.finance_snapshot",
    title="Money In / Money Out",
    instruction="Is revenue on track? Any overdue invoices?",
    icon="\U0001f4b0",  # money bag
    renderer="render_finance_snapshot",
    required_view_keys=["cc.finance_snapshot"],
)

SYSTEMS_RELIABILITY = WidgetSpec(
    widget_key="cc.systems_reliability",
    title="Systems Health",
    instruction="All green = systems running. Any red = check Ops Console.",
    icon="\u2699\ufe0f",  # gear
    renderer="render_systems_reliability",
    required_view_keys=["audit.recent"],
)

FIX_LIST = WidgetSpec(
    widget_key="cc.fix_list",
    title="Fix List",
    instruction="Work through these items to get your workspace fully set up.",
    icon="\U0001f527",  # wrench
    renderer="render_fix_list_widget",
    required_view_keys=[],  # No view dependencies — driven by compliance result
)

SKILLS_RECOMMENDATIONS = WidgetSpec(
    widget_key="cc.skills_recommendations",
    title="Skills to Fork",
    instruction="Review these skill candidates. Fork safe ones into your workspace.",
    icon="\U0001f50c",  # electric plug
    renderer="render_skills_recommendations_widget",
    required_view_keys=[],  # No view dependencies — driven by scout report
)

DB_REGISTRY = WidgetSpec(
    widget_key="cc.db_registry",
    title="Database Registry",
    instruction="Check that all OpenClaw databases exist and are compliant.",
    icon="\U0001f5c4\ufe0f",  # file cabinet
    renderer="render_db_registry_widget",
    required_view_keys=[],  # No view dependencies — driven by DB status
)

KPIS = WidgetSpec(
    widget_key="cc.kpis",
    title="Today (KPIs)",
    instruction="Check the numbers. Green = good. Yellow = watch. Red = fix now.",
    icon="\U0001f4ca",  # bar chart
    renderer="render_cc_kpis_widget",
    required_view_keys=["cc.active_combos", "cc.pipeline_quality", "cc.finance_snapshot"],
)

PIPELINE = WidgetSpec(
    widget_key="cc.pipeline",
    title="Pipeline",
    instruction="Goal: move leads forward. Open the pipeline board below.",
    icon="\U0001f4de",  # telephone
    renderer="render_cc_pipeline_widget",
    required_view_keys=["cc.pipeline_quality", "meetings.showed_7d"],
)

CASH = WidgetSpec(
    widget_key="cc.cash",
    title="Cash & Profit",
    instruction="Simple rule: revenue minus spend. Keep this green.",
    icon="\U0001f4b0",  # money bag
    renderer="render_cc_cash_widget",
    required_view_keys=["cc.finance_snapshot"],
)

CALENDAR = WidgetSpec(
    widget_key="cc.calendar",
    title="Meetings",
    instruction="Today's calls. If it's booked, make sure it shows.",
    icon="\U0001f4c5",  # calendar
    renderer="render_cc_calendar_widget",
    required_view_keys=["meetings.showed_7d"],
)

ALERTS = WidgetSpec(
    widget_key="cc.alerts",
    title="Alerts",
    instruction="If something is wrong, it shows up here.",
    icon="\U0001f6a8",  # rotating light
    renderer="render_cc_alerts_widget",
    required_view_keys=[],  # No view dependencies — driven by alert data
)

PROJECTS = WidgetSpec(
    widget_key="cc.projects",
    title="Active Work",
    instruction="This is what the team is working on right now.",
    icon="\U0001f6e0\ufe0f",  # hammer and wrench
    renderer="render_cc_projects_widget",
    required_view_keys=["cc.fulfillment_watchlist", "tasks.today"],
)

QUICK_ACTIONS = WidgetSpec(
    widget_key="cc.quick_actions",
    title="Quick Actions",
    instruction="Press a button, the system does the work.",
    icon="\u2705",  # check mark
    renderer="render_cc_quick_actions_widget",
    required_view_keys=[],  # No view dependencies — driven by config
)

# ─────────────────────────────────────────
# Brand-section widgets (global + per-brand)
# ─────────────────────────────────────────

GLOBAL_SECTION = WidgetSpec(
    widget_key="cc.global",
    title="All Brands — Overview",
    instruction="Combined view across Full Digital and CUTMV.",
    icon="\U0001f30d",  # globe
    renderer="render_cc_brand_section",
    required_view_keys=[
        "cc.global.kpis", "cc.global.pipeline", "cc.global.cash",
        "cc.global.delivery", "cc.global.webops",
    ],
)

FD_SECTION = WidgetSpec(
    widget_key="cc.fd",
    title="Full Digital",
    instruction="Full Digital brand — pipeline, delivery, cash.",
    icon="\U0001f4bc",  # briefcase
    renderer="render_cc_brand_section",
    required_view_keys=[
        "cc.fd.kpis", "cc.fd.pipeline", "cc.fd.cash",
        "cc.fd.delivery", "cc.fd.webops",
    ],
)

CUTMV_SECTION = WidgetSpec(
    widget_key="cc.cutmv",
    title="CUTMV",
    instruction="CUTMV brand — pipeline, delivery, cash.",
    icon="\U0001f3ac",  # clapper board
    renderer="render_cc_brand_section",
    required_view_keys=[
        "cc.cutmv.kpis", "cc.cutmv.pipeline", "cc.cutmv.cash",
        "cc.cutmv.delivery", "cc.cutmv.webops",
    ],
)

# ─────────────────────────────────────────
# Finance → GrantOps widgets
# ─────────────────────────────────────────

GRANTS_SUMMARY = WidgetSpec(
    widget_key="finance.grants.summary",
    title="GrantOps Summary",
    instruction="Check grant pipeline health. Act on anything needing attention.",
    icon="\U0001f3db",  # classical building
    renderer="render_grants_summary_widget",
    required_view_keys=["finance.grants.summary"],
)

GRANTS_NEW_TODAY = WidgetSpec(
    widget_key="finance.grants.new_today",
    title="New Grant Opportunities",
    instruction="Review today's discoveries. Draft high-fit matches.",
    icon="\U0001f4e5",  # inbox tray
    renderer="render_grants_new_today_widget",
    required_view_keys=["finance.grants.opportunities"],
)

GRANTS_HIGH_PRIORITY = WidgetSpec(
    widget_key="finance.grants.high_priority",
    title="High Priority Grants",
    instruction="These need drafts started now. Approve via Telegram if flagged.",
    icon="\U0001f525",  # fire
    renderer="render_grants_high_priority_widget",
    required_view_keys=["finance.grants.opportunities"],
)

GRANTS_PACKAGES_REVIEW = WidgetSpec(
    widget_key="finance.grants.packages_review",
    title="Packages in Review",
    instruction="Review and approve draft packages before submission.",
    icon="\U0001f4e6",  # package
    renderer="render_grants_packages_review_widget",
    required_view_keys=["finance.grants.drafts"],
)

GRANTS_SUBMISSIONS_ACTION = WidgetSpec(
    widget_key="finance.grants.submissions_action_needed",
    title="Submissions — Action Needed",
    instruction="Unblock stalled submissions. Escalate via Telegram if needed.",
    icon="\U0001f6a8",  # rotating light
    renderer="render_grants_submissions_action_widget",
    required_view_keys=["finance.grants.submissions"],
)

# Master registry list — order = display order on Command Center page
ALL_WIDGETS: list[WidgetSpec] = [
    EXECUTIVE_STRIP,
    ACTIVE_COMBOS_TABLE,
    PIPELINE_QUALITY,
    FULFILLMENT_WATCHLIST,
    FINANCE_SNAPSHOT,
    SYSTEMS_RELIABILITY,
    FIX_LIST,
    SKILLS_RECOMMENDATIONS,
    DB_REGISTRY,
    KPIS,
    PIPELINE,
    CASH,
    CALENDAR,
    ALERTS,
    PROJECTS,
    QUICK_ACTIONS,
    GLOBAL_SECTION,
    FD_SECTION,
    CUTMV_SECTION,
    GRANTS_SUMMARY,
    GRANTS_NEW_TODAY,
    GRANTS_HIGH_PRIORITY,
    GRANTS_PACKAGES_REVIEW,
    GRANTS_SUBMISSIONS_ACTION,
]

WIDGET_BY_KEY: dict[str, WidgetSpec] = {w.widget_key: w for w in ALL_WIDGETS}


def get_all_required_view_keys() -> set[str]:
    """Return the union of all view_keys required by any widget."""
    keys: set[str] = set()
    for w in ALL_WIDGETS:
        keys.update(w.required_view_keys)
    return keys


def get_widget_spec(widget_key: str) -> WidgetSpec | None:
    return WIDGET_BY_KEY.get(widget_key)


def validate_widget_views(
    widget: WidgetSpec, available_view_keys: set[str]
) -> list[str]:
    """Return list of missing view_keys for a widget."""
    return [k for k in widget.required_view_keys if k not in available_view_keys]
