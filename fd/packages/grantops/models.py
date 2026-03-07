"""GrantOps data models.

Three core entities: Opportunity, Draft, Submission.
All follow the OpenClaw pattern: Pydantic for validation, SQLite for persistence,
Notion for visibility.
"""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field

from packages.common.ids import new_id


# ── Enums ──


class OpportunityStatus(str, Enum):
    NEW = "new"
    EVALUATING = "evaluating"
    DRAFTING = "drafting"
    SUBMITTED = "submitted"
    WON = "won"
    LOST = "lost"
    EXPIRED = "expired"
    SKIPPED = "skipped"


class PortalType(str, Enum):
    SUBMITTABLE = "submittable"
    FLUXX = "fluxx"
    EMAIL = "email"
    PORTAL_OTHER = "portal_other"
    GUIDED = "guided"


class OpportunitySource(str, Enum):
    CANDID = "candid"
    GRANTS_GOV = "grants_gov"
    MANUAL = "manual"
    REFERRAL = "referral"


class Priority(str, Enum):
    URGENT = "urgent"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class DraftStatus(str, Enum):
    REQUIREMENTS_EXTRACTED = "requirements_extracted"
    DRAFTING = "drafting"
    REVIEW = "review"
    APPROVED = "approved"
    REVISION_NEEDED = "revision_needed"


class SubmissionMethod(str, Enum):
    SUBMITTABLE_API = "submittable_api"
    GUIDED_SUBMIT = "guided_submit"
    EMAIL = "email"
    MANUAL = "manual"


class SubmissionStatus(str, Enum):
    PENDING = "pending"
    SUBMITTED = "submitted"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    NEEDS_RESUBMIT = "needs_resubmit"
    BLOCKED = "blocked"


class SubmissionOutcome(str, Enum):
    PENDING = "pending"
    AWARDED = "awarded"
    DECLINED = "declined"
    WAITLISTED = "waitlisted"


# ── Models ──


class Opportunity(BaseModel):
    id: str = Field(default_factory=lambda: new_id("grant"))
    external_id: str  # dedupe key: source:provider_id
    name: str
    funder: str = ""
    deadline: Optional[str] = None  # ISO date
    amount_min_usd: Optional[float] = None
    amount_max_usd: Optional[float] = None
    fit_score: float = 0.0
    effort_score: float = 0.0
    priority: Priority = Priority.MEDIUM
    status: OpportunityStatus = OpportunityStatus.NEW
    portal_type: PortalType = PortalType.GUIDED
    portal_url: str = ""
    source: OpportunitySource = OpportunitySource.MANUAL
    brand: str = "fulldigital"
    tags: list[str] = Field(default_factory=list)
    raw_data: dict[str, Any] = Field(default_factory=dict)
    discovered_at: str = Field(default_factory=lambda: datetime.now(tz=UTC).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(tz=UTC).isoformat())

    @property
    def content_hash(self) -> str:
        """Deterministic hash for Notion mirror drift detection."""
        payload = f"{self.name}:{self.funder}:{self.deadline}:{self.fit_score}:{self.status}"
        return hashlib.sha256(payload.encode()).hexdigest()[:16]

    @property
    def amount_display(self) -> str:
        if self.amount_min_usd and self.amount_max_usd:
            return f"${self.amount_min_usd:,.0f} - ${self.amount_max_usd:,.0f}"
        if self.amount_max_usd:
            return f"Up to ${self.amount_max_usd:,.0f}"
        if self.amount_min_usd:
            return f"From ${self.amount_min_usd:,.0f}"
        return "TBD"


class Draft(BaseModel):
    id: str = Field(default_factory=lambda: new_id("draft"))
    opportunity_id: str
    name: str
    status: DraftStatus = DraftStatus.REQUIREMENTS_EXTRACTED
    narrative: str = ""
    budget: dict[str, Any] = Field(default_factory=dict)
    timeline: list[str] = Field(default_factory=list)
    attachments_ready: bool = False
    reviewer: str = ""
    review_notes: str = ""
    manifest: dict[str, Any] = Field(default_factory=dict)
    vault_snapshot_id: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(tz=UTC).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(tz=UTC).isoformat())

    @property
    def content_hash(self) -> str:
        payload = f"{self.name}:{self.status}:{self.narrative[:50]}:{self.attachments_ready}"
        return hashlib.sha256(payload.encode()).hexdigest()[:16]


class Submission(BaseModel):
    id: str = Field(default_factory=lambda: new_id("sub"))
    opportunity_id: str
    draft_id: Optional[str] = None
    name: str
    method: SubmissionMethod = SubmissionMethod.GUIDED_SUBMIT
    status: SubmissionStatus = SubmissionStatus.PENDING
    submitted_at: Optional[str] = None
    confirmation_id: str = ""
    blocker_reason: str = ""
    follow_up_date: Optional[str] = None
    outcome: SubmissionOutcome = SubmissionOutcome.PENDING
    award_amount_usd: Optional[float] = None
    notes: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(tz=UTC).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(tz=UTC).isoformat())

    @property
    def content_hash(self) -> str:
        payload = f"{self.name}:{self.status}:{self.outcome}:{self.confirmation_id}"
        return hashlib.sha256(payload.encode()).hexdigest()[:16]
