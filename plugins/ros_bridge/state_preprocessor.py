from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_DEFAULT_REQUIRED_FIELDS = ("position", "velocity", "acceleration", "timestamp")
_PROTOCOL_PATH = Path(__file__).with_name("protocol_definition.json")
_VECTOR_KEYS = ("x", "y", "z")


def _load_required_fields() -> Tuple[str, ...]:
    try:
        raw = _PROTOCOL_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return _DEFAULT_REQUIRED_FIELDS

    required = data.get("required") if isinstance(data, dict) else None
    if isinstance(required, dict):
        fields = [name for name in required.keys() if isinstance(name, str) and name.strip()]
        if fields:
            return tuple(fields)

    return _DEFAULT_REQUIRED_FIELDS


_REQUIRED_FIELDS = _load_required_fields()


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def _parse_vector(value: Any) -> Optional[List[float]]:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        if all(_is_finite_number(v) for v in value):
            return [float(v) for v in value]
        return None

    if isinstance(value, dict):
        if not all(k in value for k in _VECTOR_KEYS):
            return None
        vals = [value[k] for k in _VECTOR_KEYS]
        if all(_is_finite_number(v) for v in vals):
            return [float(v) for v in vals]
        return None

    return None


def _extract_state(data: Any) -> Optional[Dict[str, Any]]:
    """Validate required fields defined by protocol_definition.json."""
    if not isinstance(data, dict):
        return None

    for field in _REQUIRED_FIELDS:
        if field not in data:
            return None

    timestamp = data["timestamp"]
    if not _is_finite_number(timestamp):
        return None

    position = _parse_vector(data["position"])
    velocity = _parse_vector(data["velocity"])
    acceleration = _parse_vector(data["acceleration"])

    if position is None or velocity is None or acceleration is None:
        return None

    return {
        "timestamp": float(timestamp),
        "position": position,
        "velocity": velocity,
        "acceleration": acceleration,
    }


def _sanitize_rate(max_rate_hz: Any) -> float:
    try:
        value = float(max_rate_hz)
    except (TypeError, ValueError):
        return 10.0
    if not math.isfinite(value) or value <= 0:
        return 10.0
    return value


class StatePreprocessor:
    """Validate and downsample JSON state messages."""

    def __init__(self, max_rate_hz: float = 10.0, include_summary: bool = False) -> None:
        self._max_rate_hz = _sanitize_rate(max_rate_hz)
        self._min_interval = 1.0 / self._max_rate_hz
        self._include_summary = bool(include_summary)

        self._last_timestamp: Optional[float] = None
        self._received = 0
        self._emitted = 0
        self._dropped = 0

    def process(self, state_json_str: str) -> Optional[Dict[str, Any]]:
        """Return normalized state payload or None when dropped."""
        self._received += 1

        if not isinstance(state_json_str, str):
            self._dropped += 1
            return None

        try:
            payload = json.loads(state_json_str)
        except json.JSONDecodeError:
            self._dropped += 1
            return None

        state = _extract_state(payload)
        if state is None:
            self._dropped += 1
            return None

        timestamp = state["timestamp"]
        if self._last_timestamp is not None:
            if timestamp >= self._last_timestamp:
                if (timestamp - self._last_timestamp) < self._min_interval:
                    self._dropped += 1
                    return None

        self._last_timestamp = timestamp
        self._emitted += 1

        output: Dict[str, Any] = {"state": state}
        if self._include_summary:
            output["summary"] = {
                "max_rate_hz": self._max_rate_hz,
                "received": self._received,
                "emitted": self._emitted,
                "dropped": self._dropped,
                "last_emitted_timestamp": self._last_timestamp,
            }
        return output
