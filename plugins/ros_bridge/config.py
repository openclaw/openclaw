from __future__ import annotations

import math
import os
from typing import Any, Dict, Optional

__all__ = ["resolve_config"]

_DEFAULT_ENABLED = True
_DEFAULT_MAX_RATE_HZ = 10.0
_DEFAULT_PROFILING = False


def _parse_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "t", "yes", "y", "on", "enabled"}:
            return True
        if text in {"0", "false", "f", "no", "n", "off", "disabled"}:
            return False
    return None


def _parse_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def resolve_config(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Resolve bridge configuration from env vars + optional overrides."""
    env_enabled = _parse_bool(os.getenv("ROS_BRIDGE_ENABLED"))
    env_max_rate = _parse_float(os.getenv("ROS_BRIDGE_MAX_RATE"))
    env_profiling = _parse_bool(os.getenv("ROS_BRIDGE_PROFILING"))

    config: Dict[str, Any] = {
        "enabled": env_enabled if env_enabled is not None else _DEFAULT_ENABLED,
        "state_max_rate_hz": env_max_rate if env_max_rate is not None else _DEFAULT_MAX_RATE_HZ,
        "enable_profiling": env_profiling if env_profiling is not None else _DEFAULT_PROFILING,
    }

    if isinstance(overrides, dict):
        config.update(overrides)

    return config
