"""
LLM Council Gate — open-ended verification via independent reviewer agents.
Gate 5 of the Governed Agents verification pipeline.
"""
from dataclasses import dataclass, field
from typing import Optional
import json


@dataclass
class CouncilVerdict:
    reviewer_id: str
    verdict: str = "reject"       # "approve" | "reject"
    confidence: float = 0.5
    strengths: list[str] = field(default_factory=list)
    weaknesses: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    raw: str = ""
    parse_success: bool = False

    @classmethod
    def from_output(cls, raw: str, reviewer_id: str) -> "CouncilVerdict":
        v = cls(reviewer_id=reviewer_id, raw=raw)
        try:
            json_str = raw
            if "{" in raw:
                json_str = raw[raw.find("{"):raw.rfind("}")+1]
            data = json.loads(json_str)
            v.verdict = str(data.get("verdict", "reject")).lower()
            if v.verdict not in ("approve", "reject"):
                v.verdict = "reject"
            v.confidence = max(0.0, min(1.0, float(data.get("confidence", 0.5))))
            v.strengths = data.get("strengths", []) if isinstance(data.get("strengths"), list) else []
            v.weaknesses = data.get("weaknesses", []) if isinstance(data.get("weaknesses"), list) else []
            v.missing = data.get("missing", []) if isinstance(data.get("missing"), list) else []
            v.parse_success = True
        except Exception:
            v.verdict = "reject"
            v.parse_success = False
        return v


@dataclass
class CouncilResult:
    passed: bool
    score: float
    approvals: int
    total: int
    verdicts: list[CouncilVerdict] = field(default_factory=list)
    summary: str = ""

    @property
    def details(self) -> str:
        return self.summary


def generate_reviewer_prompt(
    objective: str,
    criteria: list[str],
    agent_output: str,
    custom_prompt: Optional[str] = None,
) -> str:
    # NOTE: agent_output is injected unfiltered — prompt injection risk if the
    # reviewed agent embeds adversarial instructions in its output.
    # Mitigation: use a stronger model for reviewers than for the task agent.
    criteria_text = "\n".join(f"- {c}" for c in criteria)
    instruction = custom_prompt or (
        "You are an independent reviewer. Be precise and critical. "
        "An honest rejection is more valuable than a false approval."
    )
    return f"""COUNCIL REVIEW REQUEST

{instruction}

Task Objective: {objective}

Acceptance Criteria:
{criteria_text}

--- OUTPUT TO REVIEW ---
{agent_output}
---

Return ONLY this JSON (no other text):
{{
  \"verdict\": \"approve\",
  \"confidence\": 0.8,
  \"strengths\": [\"strength 1\"],
  \"weaknesses\": [\"weakness 1\"],
  \"missing\": [\"missing item\"]
}}

verdict must be exactly \"approve\" or \"reject\".
"""


def aggregate_votes(
    verdicts: list[CouncilVerdict],
    threshold: float = 0.5,
) -> CouncilResult:
    if not verdicts:
        return CouncilResult(
            passed=False, score=0.0, approvals=0, total=0,
            summary="No verdicts received — defaulting to FAIL"
        )

    approvals = sum(1 for v in verdicts if v.verdict == "approve")
    total = len(verdicts)
    score = approvals / total
    passed = approvals > total / 2  # strict majority (50/50 = FAIL)

    all_weaknesses = list(dict.fromkeys(
        w for v in verdicts for w in v.weaknesses
    ))[:5]
    all_missing = list(dict.fromkeys(
        m for v in verdicts for m in v.missing
    ))[:3]

    summary = (
        f"Council: {approvals}/{total} approved "
        f"(score={score:.2f}, {'PASS ✅' if passed else 'FAIL ❌'})"
    )
    if all_weaknesses:
        summary += "\nWeaknesses: " + "; ".join(all_weaknesses)
    if all_missing:
        summary += "\nMissing: " + "; ".join(all_missing)

    return CouncilResult(
        passed=passed, score=score,
        approvals=approvals, total=total,
        verdicts=verdicts, summary=summary,
    )
