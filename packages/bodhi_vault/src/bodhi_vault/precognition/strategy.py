"""
bodhi_vault.precognition.strategy — Map SomaticState to ResponseStrategy.

ResponseStrategy tells Bo HOW to respond, not WHAT to respond.
It is the bridge between the pre-cognition layer (what state is this person in?)
and the response generation layer (what kind of response is even possible?).

The four strategies map directly to polyvagal tiers:

    GREEN  → full inquiry mode, ZPD-appropriate, ask before advising
    YELLOW → co-regulate first, then inquiry; simplified; somatic-first
    ORANGE → somatic-only; no cognitive content; max one question
    RED    → presence only; stop counseling; activate human escalation

Design:
- ResponseStrategy is immutable data — it doesn't generate text
- All decisions here are made once, before any LLM call
- The strategy is passed to Bo as part of SOMATIC_CONTEXT
- Bo generates text that honors the strategy; it doesn't know about this module
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from bodhi_vault.precognition.state import SomaticState, Tier, ZpdEstimate


Approach = Literal["inquiry", "co_regulate_then_inquiry", "somatic_only", "crisis"]
ComplexityCap = Literal["simplified", "normal", "complex"]


# Presence statements for each tier — used when Bo needs a fallback
PRESENCE_STATEMENTS: dict[Tier, str] = {
    "green": "I'm here.",
    "yellow": "I hear you. Take a breath. I'm here.",
    "orange": "I'm with you. You don't have to figure this out right now.",
    "red": "I'm here. You matter. A person who cares about you needs to know what you just shared.",
}

# The single ORANGE question — no alternatives, no rephrasing
ORANGE_SOMATIC_QUESTION = "What does your body need right now?"

# Crisis acknowledgment for RED tier
RED_ACKNOWLEDGMENT = (
    "What you just shared matters. I can hold this with you, "
    "but I'm not the right support for this moment. "
    "Please reach out to someone who can be there with you — "
    "a friend, a family member, a crisis line."
)


@dataclass(frozen=True)
class ResponseStrategy:
    """
    The response strategy for this message.

    Fields:
        tier: The polyvagal tier that determined this strategy
        approach: How to structure the response
        complexity_cap: Maximum complexity Bo should use
        somatic_first: If True, acknowledge body signals before any cognitive content
        ask_before_advising: If True, always ask what kind of support is wanted
        emergency_flag: If True, activate human escalation
        presence_statement: A safe fallback statement for this tier
    """

    tier: Tier
    approach: Approach
    complexity_cap: ComplexityCap
    somatic_first: bool
    ask_before_advising: bool
    emergency_flag: bool
    presence_statement: str


def select_strategy(state: SomaticState) -> ResponseStrategy:
    """
    Map a SomaticState to a ResponseStrategy.

    This function is the only place where tier → strategy translation happens.
    Keep it simple. Keep it explicit. No scoring, no fuzzy logic.

    Args:
        state: The inferred somatic state

    Returns:
        ResponseStrategy appropriate for this state
    """
    tier = state.tier

    if tier == "red":
        return ResponseStrategy(
            tier="red",
            approach="crisis",
            complexity_cap="simplified",
            somatic_first=True,
            ask_before_advising=False,  # no advising at RED
            emergency_flag=True,
            presence_statement=PRESENCE_STATEMENTS["red"],
        )

    if tier == "orange":
        # Somatic-only. One question maximum. No cognitive content.
        # Do not attempt to explore, reframe, or advise.
        complexity: ComplexityCap = "simplified"
        return ResponseStrategy(
            tier="orange",
            approach="somatic_only",
            complexity_cap=complexity,
            somatic_first=True,
            ask_before_advising=False,
            emergency_flag=False,
            presence_statement=PRESENCE_STATEMENTS["orange"],
        )

    if tier == "yellow":
        # Co-regulate first. Acknowledge the state. Simplify if indicated.
        # Inquiry is allowed but only after the state is acknowledged.
        cap = _zpd_to_complexity(state.zpd_estimate)
        return ResponseStrategy(
            tier="yellow",
            approach="co_regulate_then_inquiry",
            complexity_cap=cap,
            somatic_first=len(state.somatic_signals) > 0,
            ask_before_advising=True,
            emergency_flag=False,
            presence_statement=PRESENCE_STATEMENTS["yellow"],
        )

    # GREEN — full inquiry, ZPD-appropriate
    cap = _zpd_to_complexity(state.zpd_estimate)
    return ResponseStrategy(
        tier="green",
        approach="inquiry",
        complexity_cap=cap,
        somatic_first=len(state.somatic_signals) > 0,
        ask_before_advising=True,
        emergency_flag=False,
        presence_statement=PRESENCE_STATEMENTS["green"],
    )


def _zpd_to_complexity(zpd: ZpdEstimate) -> ComplexityCap:
    """ZPD estimate maps 1:1 to complexity cap."""
    if zpd == "simplified":
        return "simplified"
    elif zpd == "complex":
        return "complex"
    return "normal"


def strategy_to_context_section(strategy: ResponseStrategy) -> str:
    """
    Format the strategy as the final section of SOMATIC_CONTEXT.md.
    This is what Bo reads to understand what to do.
    """
    approach_labels = {
        "inquiry": "Full inquiry — ask open questions, explore at ZPD depth",
        "co_regulate_then_inquiry": "Co-regulate first — acknowledge the state before any question",
        "somatic_only": "Somatic-only — no cognitive content, no advice, body language only",
        "crisis": "Crisis protocol — presence only, stop all counseling, activate human",
    }

    cap_labels = {
        "simplified": "simplified (short sentences, concrete words, no lists or complex structure)",
        "normal": "normal",
        "complex": "complex (nuanced, multi-part responses okay)",
    }

    lines = [
        "## Response Strategy",
        f"- Approach: {approach_labels[strategy.approach]}",
        f"- Complexity cap: {cap_labels[strategy.complexity_cap]}",
        f"- Somatic-first: {'yes — acknowledge body signals before anything else' if strategy.somatic_first else 'no'}",
        f"- Ask before advising: {'yes' if strategy.ask_before_advising else 'no — do not advise'}",
    ]

    if strategy.emergency_flag:
        lines += [
            "",
            "**EMERGENCY FLAG: ACTIVE**",
            "Do not attempt to provide counseling. Do not ask exploratory questions.",
            f"Presence statement: \"{strategy.presence_statement}\"",
            f"Follow with: \"{RED_ACKNOWLEDGMENT}\"",
        ]
    elif strategy.approach == "somatic_only":
        lines += [
            "",
            f"Presence statement: \"{strategy.presence_statement}\"",
            f"If a question is appropriate: \"{ORANGE_SOMATIC_QUESTION}\"",
            "Nothing more.",
        ]
    else:
        lines.append(f"- Fallback presence statement: \"{strategy.presence_statement}\"")

    return "\n".join(lines)
