"""
ra2.ledger — Structured ledger memory (one per stream).

Each stream gets a JSON ledger file with bounded fields.
Fields are overwritten (never appended unbounded).
Only updated via the compression pass.
"""

import json
import os
from typing import Optional

# Configurable storage root
LEDGER_DIR: str = os.environ.get(
    "RA2_LEDGER_DIR",
    os.path.join(os.path.expanduser("~"), ".ra2", "ledgers"),
)

# Hard limits
MAX_BLOCKERS = 10
MAX_OPEN = 10
MAX_FIELD_CHARS = 500  # per string field

_EMPTY_LEDGER = {
    "stream": "",
    "orientation": "",
    "latest": "",
    "blockers": [],
    "open": [],
    "delta": "",
}


def _ledger_path(stream_id: str) -> str:
    return os.path.join(LEDGER_DIR, f"{stream_id}.json")


def load(stream_id: str) -> dict:
    """Load ledger for *stream_id*, returning empty template if none exists."""
    path = _ledger_path(stream_id)
    if not os.path.exists(path):
        ledger = dict(_EMPTY_LEDGER)
        ledger["stream"] = stream_id
        return ledger
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    # Ensure all expected keys exist
    for key, default in _EMPTY_LEDGER.items():
        if key not in data:
            data[key] = default if not isinstance(default, list) else list(default)
    return data


def save(stream_id: str, ledger: dict) -> None:
    """Persist ledger to disk, enforcing size limits."""
    ledger = _enforce_limits(ledger)
    os.makedirs(LEDGER_DIR, exist_ok=True)
    path = _ledger_path(stream_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2, ensure_ascii=False)


def update(stream_id: str, **fields) -> dict:
    """Load, merge fields, save, and return the updated ledger.

    Only known keys are accepted.  Unknown keys are silently dropped.
    """
    ledger = load(stream_id)
    for key, value in fields.items():
        if key in _EMPTY_LEDGER:
            ledger[key] = value
    save(stream_id, ledger)
    return ledger


def snapshot(stream_id: str) -> str:
    """Return a human-readable snapshot string for prompt injection."""
    ledger = load(stream_id)
    lines = []
    lines.append(f"stream: {ledger['stream']}")
    lines.append(f"orientation: {ledger['orientation']}")
    lines.append(f"latest: {ledger['latest']}")
    if ledger["blockers"]:
        lines.append("blockers:")
        for b in ledger["blockers"]:
            lines.append(f"  - {b}")
    if ledger["open"]:
        lines.append("open:")
        for o in ledger["open"]:
            lines.append(f"  - {o}")
    if ledger["delta"]:
        lines.append(f"delta: {ledger['delta']}")
    return "\n".join(lines)


def _enforce_limits(ledger: dict) -> dict:
    """Truncate fields and lists to hard limits."""
    for key in ("orientation", "latest", "delta", "stream"):
        if isinstance(ledger.get(key), str) and len(ledger[key]) > MAX_FIELD_CHARS:
            ledger[key] = ledger[key][:MAX_FIELD_CHARS]
    if isinstance(ledger.get("blockers"), list):
        ledger["blockers"] = [
            b[:MAX_FIELD_CHARS] if isinstance(b, str) else b
            for b in ledger["blockers"][:MAX_BLOCKERS]
        ]
    if isinstance(ledger.get("open"), list):
        ledger["open"] = [
            o[:MAX_FIELD_CHARS] if isinstance(o, str) else o
            for o in ledger["open"][:MAX_OPEN]
        ]
    return ledger
