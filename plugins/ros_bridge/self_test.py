from __future__ import annotations

import json
import time
from typing import Any, Dict

try:
    from .config import resolve_config
    from .latency_profiler import LatencyProfiler
    from .state_preprocessor import StatePreprocessor
except ImportError:
    from config import resolve_config
    from latency_profiler import LatencyProfiler
    from state_preprocessor import StatePreprocessor

__all__ = ["run_self_test"]


def _sample_state() -> Dict[str, Any]:
    timestamp_ms = time.time() * 1000.0
    return {
        "timestamp": timestamp_ms,
        "position": {"x": 0.0, "y": 0.0, "z": 0.0},
        "velocity": {"x": 0.1, "y": 0.0, "z": 0.0},
        "acceleration": {"x": 0.0, "y": 0.0, "z": 0.0},
        "source": "self_test",
    }


def _serialize_command() -> str:
    payload = json.dumps(
        {"action": "ping", "source": "self_test"},
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )
    if not payload:
        raise RuntimeError("Command serialization failed")
    return payload


def run_self_test() -> None:
    """Run a minimal in-process self-test without ROS runtime."""
    config = resolve_config()
    preprocessor = StatePreprocessor(
        max_rate_hz=config.get("state_max_rate_hz", 10.0),
        include_summary=False,
    )
    profiler = LatencyProfiler(enabled=bool(config.get("enable_profiling", False)))

    state_json = json.dumps(
        _sample_state(),
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )

    trace_id = profiler.mark_rx()
    processed = preprocessor.process(state_json)
    profiler.mark_preprocess(trace_id)

    if processed is None:
        raise RuntimeError("State preprocessor returned None")

    _serialize_command()
    profiler.mark_publish(trace_id)
    print("SELF TEST PASSED")


def main() -> None:
    """CLI entry point for `python -m plugins.ros_bridge.self_test`."""
    run_self_test()


if __name__ == "__main__":
    main()
