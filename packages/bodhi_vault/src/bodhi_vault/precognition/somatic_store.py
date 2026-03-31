"""
bodhi_vault.precognition.somatic_store — Atomic read/write for somatic state files.

Two persistence mechanisms:
1. somatic-state.json — current state (single object, overwritten each message)
2. somatic-history.jsonl — append-only log, one JSON line per message

Both use atomic writes (tempfile + os.replace) consistent with the rest of
bodhi_vault's file I/O safety pattern.

The history log enables longitudinal pattern tracking (future: cross-session
ZPD trajectory, attachment mode evolution, circadian baseline).
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from bodhi_vault.precognition.state import SomaticState, Tier, CircadianPhase, ZpdEstimate, AttachmentSignal


SOMATIC_STATE_PATH = Path(os.path.expanduser("~/.openclaw/somatic-state.json"))
SOMATIC_HISTORY_PATH = Path(os.path.expanduser("~/.openclaw/somatic-history.jsonl"))

# How long before a somatic state is considered stale (minutes)
STALE_AFTER_MINUTES = 5


def save_state(state: SomaticState, path: Path = SOMATIC_STATE_PATH) -> None:
    """
    Atomically write the current somatic state to disk.

    Uses tempfile + os.replace so partial writes never corrupt the state file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    data = state.to_dict()

    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".somatic-state-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        # Clean up temp file if something goes wrong; re-raise
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_state(path: Path = SOMATIC_STATE_PATH) -> Optional[SomaticState]:
    """
    Load the current somatic state from disk.

    Returns None if the file doesn't exist, can't be read, or is malformed.
    Never raises — callers should treat None as "no state available."
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return _state_from_dict(data)
    except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError):
        return None


def is_state_fresh(
    state: Optional[SomaticState],
    stale_after_minutes: int = STALE_AFTER_MINUTES,
) -> bool:
    """
    Return True if the state was written within the stale window.

    A stale state (older than 5 minutes) should not be injected into bootstrap —
    the person may have moved on and the old state would mislead Bo.
    """
    if state is None or not state.message_timestamp:
        return False
    try:
        ts = datetime.fromisoformat(state.message_timestamp)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        now = datetime.now(tz=timezone.utc)
        return (now - ts) < timedelta(minutes=stale_after_minutes)
    except (ValueError, TypeError):
        return False


def append_history(state: SomaticState, path: Path = SOMATIC_HISTORY_PATH) -> None:
    """
    Append the current state to the append-only history log.

    Each line is a JSON object. The log is never rewritten — only appended.
    This enables future longitudinal analysis without risking data loss.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(state.to_dict(), separators=(",", ":")) + "\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)


def load_history(
    path: Path = SOMATIC_HISTORY_PATH,
    days: int = 7,
) -> list[SomaticState]:
    """
    Load somatic state history for the past N days.

    Returns states in chronological order (oldest first).
    Malformed lines are skipped silently.
    """
    if not path.exists():
        return []

    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
    states: list[SomaticState] = []

    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    state = _state_from_dict(data)
                    if state.message_timestamp:
                        ts = datetime.fromisoformat(state.message_timestamp)
                        if ts.tzinfo is None:
                            ts = ts.replace(tzinfo=timezone.utc)
                        if ts >= cutoff:
                            states.append(state)
                except (json.JSONDecodeError, KeyError, ValueError):
                    continue
    except OSError:
        return []

    return states


def _state_from_dict(data: dict) -> SomaticState:
    """Reconstruct a SomaticState from a raw dict. Raises KeyError/ValueError on bad data."""
    return SomaticState(
        tier=data["tier"],
        circadian_phase=data["circadian_phase"],
        sleep_signal=data.get("sleep_signal", False),
        zpd_estimate=data.get("zpd_estimate", "normal"),
        attachment_signal=data.get("attachment_signal", "neutral"),
        somatic_signals=data.get("somatic_signals", []),
        incongruence_detected=data.get("incongruence_detected", False),
        crisis_signals_raw=data.get("crisis_signals_raw", []),
        message_timestamp=data.get("message_timestamp", ""),
        message_word_count=data.get("message_word_count", 0),
    )
