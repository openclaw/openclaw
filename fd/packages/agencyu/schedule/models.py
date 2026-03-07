"""Schedule & Goals dataclasses — pure data, no DB logic."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class ScheduleEvent:
    """A single schedule entry from any source."""

    brand: str
    source: str  # trello | gcal | ghl | manual
    event_type: str  # deadline | meeting | focus_block | reminder | appointment
    title: str
    start_time: datetime
    end_time: datetime | None = None
    all_day: bool = False
    external_key: str | None = None
    location: str | None = None
    attendees: list[str] = field(default_factory=list)
    trello_card_id: str | None = None
    gcal_event_id: str | None = None
    ghl_appointment_id: str | None = None
    status: str = "scheduled"
    conflict_flag: bool = False
    notes: str | None = None
    id: int | None = None
    notion_page_id: str | None = None


@dataclass
class Goal:
    """A brand-level KPI target."""

    brand: str
    kpi_key: str  # calls_booked | trials | paid | revenue | close_rate
    cadence: str  # daily | weekly
    target_value: float
    current_value: float = 0.0
    progress_pct: float = 0.0
    status: str = "active"
    start_date: str | None = None
    end_date: str | None = None
    notes: str | None = None
    id: int | None = None


@dataclass
class DailyPlan:
    """Aggregated daily snapshot for one brand."""

    brand: str
    plan_date: str  # YYYY-MM-DD
    goal_chip: str = ""
    schedule_summary: str = ""
    top_priorities: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    status: str = "draft"
    notion_page_id: str | None = None
    id: int | None = None


@dataclass
class GoalChip:
    """Pre-formatted goal chip for display on brand tiles."""

    brand: str
    kpi_key: str
    target: float
    current: float
    progress_pct: float
    chip_text: str  # e.g. "Goal • 10 calls • 70%"
