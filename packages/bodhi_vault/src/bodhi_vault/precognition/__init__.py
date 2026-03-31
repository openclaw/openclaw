"""
bodhi_vault.precognition — Pre-cognition layer for OpenBodhi.

Runs BEFORE the LLM generates a response. Infers the user's nervous system
state from the message and time-of-day, selects a response strategy, and
writes the result to ~/.openclaw/somatic-state.json for Bo to read at bootstrap.

Public API:
    run_precognition(text, timestamp, channel) -> tuple[SomaticState, ResponseStrategy]

This is the only function callers outside this package need.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from bodhi_vault.precognition.signals import extract_signals
from bodhi_vault.precognition.state import SomaticState, infer_state
from bodhi_vault.precognition.strategy import ResponseStrategy, select_strategy
from bodhi_vault.precognition.somatic_store import (
    SOMATIC_STATE_PATH,
    SOMATIC_HISTORY_PATH,
    save_state,
    append_history,
)


def run_precognition(
    text: str,
    timestamp: Optional[datetime] = None,
    channel: str = "telegram",
) -> tuple[SomaticState, ResponseStrategy]:
    """
    Run the full pre-cognition pipeline for a single message.

    Steps:
    1. Extract signals from message text (pure text analysis, no LLM)
    2. Infer somatic state (tier, circadian phase, ZPD, attachment, incongruence)
    3. Select response strategy (GREEN/YELLOW/ORANGE/RED approach)
    4. Persist state to disk (somatic-state.json + somatic-history.jsonl)

    Args:
        text: The message body (fully preprocessed — transcription done)
        timestamp: When the message was received (UTC). Defaults to now.
        channel: Channel identifier (e.g. "telegram"). Stored for context.

    Returns:
        (SomaticState, ResponseStrategy) — both are data; neither generates text.

    Side effects:
        - Writes ~/.openclaw/somatic-state.json (atomic)
        - Appends to ~/.openclaw/somatic-history.jsonl
    """
    if timestamp is None:
        timestamp = datetime.now(tz=timezone.utc)

    signals = extract_signals(text)
    state = infer_state(signals, timestamp=timestamp)
    strategy = select_strategy(state)

    # Persist (both calls are safe to fail silently from caller's perspective)
    save_state(state, SOMATIC_STATE_PATH)
    append_history(state, SOMATIC_HISTORY_PATH)

    return state, strategy


__all__ = [
    "run_precognition",
    "SomaticState",
    "ResponseStrategy",
]
