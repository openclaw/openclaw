"""Intent classification and action planning models.

The intent layer sits between raw user prompts and system actions.
It classifies what the user wants, maps it to internal capabilities,
and builds a small execution plan.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Optional


class IntentCategory(str, enum.Enum):
    """Top-level categories of user intent."""

    INFORMATION = "information"  # "What grants are available?"
    SYSTEM_HEALTH = "system_health"  # "Check the cluster"
    WORKFLOW_EXECUTE = "workflow_execute"  # "Run the grant scan"
    CONTENT_GENERATE = "content_generate"  # "Write three ad hooks"
    APPROVAL_DECISION = "approval_decision"  # "Approve the submission"
    ANALYSIS = "analysis"  # "Why did ads underperform?"
    CONFIGURATION = "configuration"  # "Enable GrantOps"
    CONVERSATION = "conversation"  # General chat / unclear intent


class Brand(str, enum.Enum):
    """Brand context for intent routing."""

    FULLDIGITAL = "fulldigital"
    CUTMV = "cutmv"
    UNKNOWN = "unknown"


class Confidence(str, enum.Enum):
    """How confident the classifier is in its result."""

    HIGH = "high"  # >= 0.8 — proceed without clarification
    MEDIUM = "medium"  # 0.5–0.8 — proceed but note uncertainty
    LOW = "low"  # < 0.5 — ask for clarification


class RiskLevel(enum.IntEnum):
    """Risk level of the planned action."""

    SAFE = 0  # Read-only, no side effects
    MODERATE = 1  # Internal writes, reversible
    HIGH = 2  # External writes, client-facing, financial


@dataclass
class ClassifiedIntent:
    """Result of intent classification."""

    category: IntentCategory
    confidence: Confidence
    brand: Brand = Brand.UNKNOWN
    domain: str = ""  # e.g. "grantops", "marketing", "cluster", "sales"
    action_hint: str = ""  # e.g. "daily_scan", "health_check", "generate_hooks"
    entities: dict[str, Any] = field(default_factory=dict)  # Extracted entities
    raw_prompt: str = ""

    @property
    def needs_clarification(self) -> bool:
        return self.confidence == Confidence.LOW

    @property
    def needs_brand_disambiguation(self) -> bool:
        return self.brand == Brand.UNKNOWN and self.category in (
            IntentCategory.WORKFLOW_EXECUTE,
            IntentCategory.CONTENT_GENERATE,
        )


@dataclass
class ActionStep:
    """A single step in an execution plan."""

    description: str  # Human-readable: "Query grant databases"
    system_call: str  # Internal: "grantops.scanner.run_daily_scan"
    risk_level: RiskLevel = RiskLevel.SAFE
    requires_approval: bool = False
    estimated_seconds: Optional[int] = None


@dataclass
class ActionPlan:
    """Execution plan built from classified intent."""

    intent: ClassifiedIntent
    steps: list[ActionStep] = field(default_factory=list)
    requires_approval: bool = False
    risk_level: RiskLevel = RiskLevel.SAFE
    target_agent: str = ""  # e.g. "fulldigital-finance"
    human_summary: str = ""  # Plain English plan description

    @property
    def is_safe(self) -> bool:
        return self.risk_level == RiskLevel.SAFE

    @property
    def step_count(self) -> int:
        return len(self.steps)

    def add_step(
        self,
        description: str,
        system_call: str,
        risk: RiskLevel = RiskLevel.SAFE,
        approval: bool = False,
        seconds: Optional[int] = None,
    ) -> None:
        step = ActionStep(
            description=description,
            system_call=system_call,
            risk_level=risk,
            requires_approval=approval,
            estimated_seconds=seconds,
        )
        self.steps.append(step)
        # Escalate plan risk level to match highest step
        if risk.value > self.risk_level.value:
            self.risk_level = risk
        if approval:
            self.requires_approval = True
