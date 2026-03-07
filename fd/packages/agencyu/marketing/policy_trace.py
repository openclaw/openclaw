"""Decision trace — structured log of why each combo was held/killed/scaled/rotated.

DecisionTrace captures every gate, signal, and rule that contributed to the
final decision for a combo. Used by policy_debug_explain() for debugging.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class TraceStep:
    """A single step in the decision pipeline."""

    gate: str  # e.g. "hold_minimums", "kill_zero_conv", "quality_gate_l2", "fatigue_b4"
    result: str  # "pass", "block", "downgrade", "rotate"
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class DecisionTrace:
    """Full trace of why a combo received its final decision.

    Captures the input metrics, each pipeline step, and the final action.
    """

    combo_id: str
    brand: str
    final_decision: str  # "hold", "pause", "scale_budget", "scale_soft", "rotate_creative", None
    steps: list[TraceStep] = field(default_factory=list)
    input_metrics: dict[str, Any] = field(default_factory=dict)
    quality_gate: dict[str, Any] | None = None
    advanced_signals: dict[str, Any] | None = None

    def add_step(self, gate: str, result: str, **detail: Any) -> None:
        """Append a trace step."""
        self.steps.append(TraceStep(gate=gate, result=result, detail=detail))

    def to_dict(self) -> dict[str, Any]:
        """Serialize to plain dict for JSON output."""
        return {
            "combo_id": self.combo_id,
            "brand": self.brand,
            "final_decision": self.final_decision,
            "steps": [
                {"gate": s.gate, "result": s.result, "detail": s.detail}
                for s in self.steps
            ],
            "input_metrics": self.input_metrics,
            "quality_gate": self.quality_gate,
            "advanced_signals": self.advanced_signals,
        }
