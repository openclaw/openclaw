"""Core data types for the OpenClaw Prompt Engine.

Every component speaks these types.  They are plain dataclasses so they
stay serialisable and easy to inspect in logs and tests.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


# ── Literal unions ──────────────────────────────────────────────────────────

IntentType = Literal[
    "question",
    "status_check",
    "run_workflow",
    "generate_content",
    "modify_system",
    "approval_decision",
    "analysis",
    "configuration",
    "conversation",
    "unknown",
]

RiskLevel = Literal["low", "medium", "high"]

ChannelType = Literal["telegram", "ui", "notion", "api", "discord", "slack"]


# ── Inbound ─────────────────────────────────────────────────────────────────

@dataclass
class UserPrompt:
    """Normalised prompt envelope from any channel."""

    text: str
    channel: ChannelType
    user_id: str
    chat_id: str | None = None
    brand_hint: str | None = None
    conversation_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# ── Intent ──────────────────────────────────────────────────────────────────

@dataclass
class Intent:
    """Structured interpretation of what the user wants."""

    intent_type: IntentType
    confidence: float
    brand: str | None = None
    workflow: str | None = None
    domain: str | None = None
    entities: dict[str, Any] = field(default_factory=dict)
    clarification_needed: bool = False
    clarification_question: str | None = None
    raw_prompt: str = ""


# ── Context ─────────────────────────────────────────────────────────────────

@dataclass
class ContextPacket:
    """Minimal business/system context gathered for a request."""

    brand: str | None
    system_state: dict[str, Any] = field(default_factory=dict)
    today_summary: dict[str, Any] = field(default_factory=dict)
    memory_notes: list[str] = field(default_factory=list)
    relevant_objects: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


# ── Action planning ─────────────────────────────────────────────────────────

@dataclass
class ActionStep:
    """A single discrete step inside an execution plan."""

    step_id: str
    description: str
    action_type: str
    executor: str
    payload: dict[str, Any] = field(default_factory=dict)
    risk_level: RiskLevel = "low"
    requires_approval: bool = False


@dataclass
class ActionPlan:
    """Full execution plan derived from an intent + context."""

    goal: str
    brand: str | None
    steps: list[ActionStep] = field(default_factory=list)
    summary_for_user: str = ""
    approval_required: bool = False
    approval_summary: str | None = None
    target_agent: str | None = None

    @property
    def step_count(self) -> int:
        return len(self.steps)

    @property
    def max_risk(self) -> RiskLevel:
        levels: dict[RiskLevel, int] = {"low": 0, "medium": 1, "high": 2}
        highest = max((levels[s.risk_level] for s in self.steps), default=0)
        return {0: "low", 1: "medium", 2: "high"}[highest]  # type: ignore[return-value]


# ── Execution result ────────────────────────────────────────────────────────

@dataclass
class ExecutionResult:
    """Outcome of running an action plan."""

    ok: bool
    summary: str
    outputs: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    approval_requested: bool = False
    approval_id: str | None = None
    correlation_id: str | None = None


# ── Engine response ─────────────────────────────────────────────────────────

@dataclass
class EngineResponse:
    """Top-level response returned by the engine to any adapter."""

    ok: bool
    reply: str
    intent: Intent | None = None
    plan: ActionPlan | None = None
    result: ExecutionResult | None = None
    conversation_id: str | None = None
