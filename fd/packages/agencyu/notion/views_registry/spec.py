"""Canonical required view specs for Command Center widgets.

Each ViewSpec maps a view_key (used by widgets) to the database it reads from,
plus metadata for the view page that gets created.

These are NOT Notion internal view objects — they are stable pages tracked
in the Views Registry DB. The Notion API cannot reliably create/verify
internal views, so we create "view pages" with instructions + DB links instead.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ViewSpec:
    """Spec for a required view page in the Views Registry."""

    view_key: str  # e.g. "cc.active_combos"
    db_key: str  # manifest database key this view reads from
    page_title: str  # title of the view page in Notion
    view_type: str  # table / board / calendar (informational)
    purpose: str  # human-readable description


def minimum_view_specs() -> list[ViewSpec]:
    """Minimum set of view specs needed to make CC widgets fully linkable.

    These match the required_views_registry_entries in template_manifest.yaml.
    """
    return [
        ViewSpec(
            view_key="cc.active_combos",
            db_key="outcomes",
            page_title="View: Active Combos (Outcomes)",
            view_type="table",
            purpose="Active client outcomes — status, owner, target date.",
        ),
        ViewSpec(
            view_key="cc.pipeline_quality",
            db_key="meetings",
            page_title="View: Pipeline Quality (Meetings)",
            view_type="table",
            purpose="Calls booked vs showed, close rate metrics.",
        ),
        ViewSpec(
            view_key="cc.finance_snapshot",
            db_key="invoices",
            page_title="View: Finance Snapshot (Invoices)",
            view_type="table",
            purpose="Revenue, outstanding invoices, payment status.",
        ),
        ViewSpec(
            view_key="cc.fulfillment_watchlist",
            db_key="tasks",
            page_title="View: Fulfillment Watchlist (Tasks)",
            view_type="table",
            purpose="Overdue and blocked tasks needing attention.",
        ),
        ViewSpec(
            view_key="audit.recent",
            db_key="system_audit_log",
            page_title="View: Recent Audit Events",
            view_type="table",
            purpose="Recent system audit events for reliability monitoring.",
        ),
        ViewSpec(
            view_key="tasks.today",
            db_key="tasks",
            page_title="View: Tasks Due Today",
            view_type="table",
            purpose="Tasks due today across all projects.",
        ),
        ViewSpec(
            view_key="meetings.showed_7d",
            db_key="meetings",
            page_title="View: Meetings Showed (7 Days)",
            view_type="table",
            purpose="Meetings that showed in the last 7 days.",
        ),
    ]
