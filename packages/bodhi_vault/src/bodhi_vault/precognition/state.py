"""
bodhi_vault.precognition.state — Infer nervous system state from extracted signals.

SomaticState is the output of this module. It is written to somatic-state.json
and injected into Bo's bootstrap context as SOMATIC_CONTEXT.md.

Inference rules:
- Tier is DOWNGRADE-SAFE: starts GREEN, can only drop
- RED wins unconditionally — explicit crisis signals override everything
- Incongruence is preserved as a flag, not resolved
- ZPD estimate uses circadian phase + fatigue signals + linguistic complexity
- Circadian phase is derived from hour-of-day only (no GPS, no calendar)

Design decisions:
- No external dependencies, stdlib only
- All inference is rules-based, not ML — deterministic, auditable, fast
- The output is data for Bo to read, not advice to act on
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional

from bodhi_vault.precognition.signals import MessageSignals


Tier = Literal["green", "yellow", "orange", "red"]
CircadianPhase = Literal["car", "morning", "afternoon", "evening", "late_night"]
ZpdEstimate = Literal["simplified", "normal", "complex"]
AttachmentSignal = Literal["reassurance_seeking", "independence_asserting", "neutral"]


@dataclass
class SomaticState:
    """
    The inferred state of the user's nervous system at the time of this message.

    This is a snapshot, not a diagnosis. It reflects observable signals
    in this single message combined with time-of-day context.

    Fields:
        tier: Polyvagal-inspired response tier (green/yellow/orange/red)
        circadian_phase: Inferred phase based on hour-of-day
        sleep_signal: True if sleep deprivation is indicated
        zpd_estimate: Complexity of response they can integrate right now
        attachment_signal: Relational stance inferred from language patterns
        somatic_signals: Verbatim body mentions from the message
        incongruence_detected: "I'm fine" language present alongside distress signals
        crisis_signals_raw: The matched crisis phrases (for audit log)
        message_timestamp: When this state was inferred
        message_word_count: Size proxy for context
    """

    tier: Tier = "green"
    circadian_phase: CircadianPhase = "morning"
    sleep_signal: bool = False
    zpd_estimate: ZpdEstimate = "normal"
    attachment_signal: AttachmentSignal = "neutral"
    somatic_signals: list[str] = field(default_factory=list)
    incongruence_detected: bool = False
    crisis_signals_raw: list[str] = field(default_factory=list)
    message_timestamp: str = ""
    message_word_count: int = 0

    def to_dict(self) -> dict:
        return {
            "tier": self.tier,
            "circadian_phase": self.circadian_phase,
            "sleep_signal": self.sleep_signal,
            "zpd_estimate": self.zpd_estimate,
            "attachment_signal": self.attachment_signal,
            "somatic_signals": self.somatic_signals,
            "incongruence_detected": self.incongruence_detected,
            "crisis_signals_raw": self.crisis_signals_raw,
            "message_timestamp": self.message_timestamp,
            "message_word_count": self.message_word_count,
        }

    def to_context_markdown(self) -> str:
        """
        Format as SOMATIC_CONTEXT.md — the file Bo reads at bootstrap.

        Bo reads tier FIRST. Everything else informs how to respond within that tier.
        """
        tier_label = {
            "green": "GREEN — full inquiry, ZPD-appropriate complexity",
            "yellow": "YELLOW — co-regulate first, then inquiry; lower complexity",
            "orange": "ORANGE — somatic-only; no cognitive content; one question max",
            "red": "RED — crisis protocol; presence only; activate human escalation",
        }[self.tier]

        zpd_label = {
            "simplified": "simplified (short sentences, concrete language, no lists)",
            "normal": "normal (standard complexity)",
            "complex": "complex (nuanced, multi-part okay)",
        }[self.zpd_estimate]

        attach_label = {
            "reassurance_seeking": "reassurance-seeking (acknowledge explicitly before anything else)",
            "independence_asserting": "independence-asserting (hold space, don't manage)",
            "neutral": "neutral",
        }[self.attachment_signal]

        lines = [
            "# SOMATIC_CONTEXT",
            "",
            "## Read this first",
            f"**Tier:** {tier_label}",
            "",
        ]

        if self.incongruence_detected:
            lines += [
                "**INCONGRUENCE DETECTED:** Language says 'fine' but somatic/crisis signals",
                "are present. Do NOT assume the stated position. Ask first.",
                "",
            ]

        lines += [
            "## State Details",
            f"- Circadian phase: {self.circadian_phase.replace('_', '-')}",
            f"- Sleep signal: {'yes — sleep deprivation indicated' if self.sleep_signal else 'no'}",
            f"- ZPD estimate: {zpd_label}",
            f"- Attachment signal: {attach_label}",
            "",
        ]

        if self.somatic_signals:
            lines += [
                "## Body Signals (verbatim from message)",
                "The body was in this message. Mirror what was named. Don't interpret it.",
            ]
            for sig in self.somatic_signals:
                lines.append(f"- {sig}")
            lines.append("")

        if self.crisis_signals_raw:
            lines += [
                "## Crisis Signals Detected",
                "These phrases were in the message:",
            ]
            for sig in self.crisis_signals_raw:
                lines.append(f"- \"{sig}\"")
            lines.append("")

        lines += [
            "## Protocol",
            "1. Read tier. Tier determines what response is possible.",
            "2. If incongruence_detected: ask, don't assume.",
            "3. Mirror somatic_signals if present. Name what was named.",
            "4. Match attachment_signal in your acknowledgment approach.",
            "5. Stay at or below ZPD estimate complexity.",
            "6. Only after all of the above: generate response.",
        ]

        return "\n".join(lines)


def _infer_circadian_phase(hour: int) -> CircadianPhase:
    """
    Map hour-of-day (0-23) to circadian phase.

    CAR = Cortisol Awakening Response window (typically 6-7am).
    Late night is the highest risk window for dysregulation.
    """
    if hour == 6 or hour == 7:
        return "car"
    elif 8 <= hour <= 11:
        return "morning"
    elif 12 <= hour <= 16:
        return "afternoon"
    elif 17 <= hour <= 20:
        return "evening"
    else:
        # 21-23 and 0-5 = late night
        return "late_night"


def _infer_zpd(
    signals: MessageSignals,
    phase: CircadianPhase,
) -> ZpdEstimate:
    """
    Estimate how much cognitive complexity the person can integrate right now.

    Simplifying factors (push toward 'simplified'):
    - Late night or sleep deprivation
    - Very short message (low energy, minimal investment)
    - Very long fatigue signal list

    Complexity indicators (push toward 'complex'):
    - High type-token ratio (rich vocabulary, engaged)
    - High clause depth (structurally sophisticated thinking)
    - Afternoon phase (peak cortisol clearance, high processing capacity)
    - Long message with high sentence variance (exploring complexity)

    Default: 'normal'
    """
    # Simplifying pressures
    simplify_score = 0

    if phase == "late_night":
        simplify_score += 2
    if signals.sleep_signal:  # type: ignore[attr-defined] — checked below
        simplify_score += 1
    if len(signals.fatigue_signals) >= 2:
        simplify_score += 2
    if signals.word_count < 10:
        simplify_score += 1  # very short = low energy
    if signals.red_signals or signals.orange_signals:
        simplify_score += 2  # crisis = no room for complexity

    # Complexity indicators
    complex_score = 0

    if signals.type_token_ratio > 0.75:
        complex_score += 1
    if signals.clause_depth >= 3:
        complex_score += 1
    if phase == "afternoon":
        complex_score += 1
    if signals.word_count > 80 and signals.sentence_length_variance > 20:
        complex_score += 1

    if simplify_score >= 3:
        return "simplified"
    elif complex_score >= 2 and simplify_score == 0:
        return "complex"
    else:
        return "normal"


def infer_state(
    signals: MessageSignals,
    timestamp: Optional[datetime] = None,
) -> SomaticState:
    """
    Infer the user's nervous system state from extracted signals.

    This is the core inference function. It is:
    - Downgrade-safe: tier can only drop, never rise based on surface language
    - Incongruence-preserving: conflicting signals are flagged, not resolved
    - Deterministic: same inputs → same output

    Args:
        signals: Extracted signals from a single message
        timestamp: When the message was received (defaults to now)

    Returns:
        SomaticState ready for storage and context injection
    """
    if timestamp is None:
        timestamp = datetime.now(tz=timezone.utc)

    ts_str = timestamp.isoformat()
    hour = timestamp.hour

    phase = _infer_circadian_phase(hour)
    sleep_signal = len(signals.fatigue_signals) > 0

    # --- Tier inference (downgrade-only) ---
    # Start at GREEN. Each check can only drop the tier.
    tier: Tier = "green"

    if signals.yellow_signals or (len(signals.somatic_mentions) >= 2 and signals.word_count < 30):
        tier = "yellow"

    # Late night + fatigue = YELLOW minimum
    if phase == "late_night" and sleep_signal:
        if tier == "green":
            tier = "yellow"

    # Multiple orange signals or late night + yellow signals = ORANGE
    if signals.orange_signals:
        tier = "orange"
    elif phase == "late_night" and signals.yellow_signals and len(signals.somatic_mentions) >= 1:
        tier = "orange"

    # RED wins unconditionally
    if signals.red_signals:
        tier = "red"

    # --- Collect all crisis signals for audit ---
    crisis_signals_raw = (
        signals.red_signals
        + signals.orange_signals
        + signals.yellow_signals
    )

    # --- Incongruence detection ---
    # "I'm fine" language present alongside actual distress signals
    distress_present = bool(
        signals.red_signals
        or signals.orange_signals
        or signals.yellow_signals
        or len(signals.somatic_mentions) >= 2
    )
    incongruence = signals.fine_language_present and distress_present

    # --- ZPD estimate ---
    # Attach sleep_signal to signals for ZPD use (duck-typed)
    class _SignalsWithSleep(type(signals)):  # type: ignore[misc]
        pass
    signals_ext = signals
    setattr(signals_ext, "sleep_signal", sleep_signal)
    zpd = _infer_zpd(signals_ext, phase)

    # --- Attachment signal ---
    if signals.reassurance_seeking:
        attachment: AttachmentSignal = "reassurance_seeking"
    elif signals.independence_asserting:
        attachment = "independence_asserting"
    else:
        attachment = "neutral"

    return SomaticState(
        tier=tier,
        circadian_phase=phase,
        sleep_signal=sleep_signal,
        zpd_estimate=zpd,
        attachment_signal=attachment,
        somatic_signals=signals.somatic_mentions,
        incongruence_detected=incongruence,
        crisis_signals_raw=crisis_signals_raw,
        message_timestamp=ts_str,
        message_word_count=signals.word_count,
    )
