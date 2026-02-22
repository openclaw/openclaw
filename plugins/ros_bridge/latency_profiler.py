from __future__ import annotations

import logging
import math
import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional, Tuple

__all__ = ["LatencyProfiler"]

_DEFAULT_SAMPLE_SIZE = 200
_DEFAULT_LOG_INTERVAL_S = 5.0
_TRACE_GROWTH_MULTIPLIER = 4
_MIN_TRACE_CAP = 256


@dataclass
class _Trace:
    rx_time: float
    preprocess_time: Optional[float] = None


def _sanitize_sample_size(value: object, default: int) -> int:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return default
    if size <= 0:
        return default
    return size


def _sanitize_interval(value: object, default: float) -> float:
    try:
        interval = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(interval) or interval <= 0:
        return default
    return interval


def _format_ms(value: float) -> str:
    return f"{value * 1000.0:.1f}ms"


def _compute_stats(values: Deque[float]) -> Optional[Tuple[float, float, int]]:
    if not values:
        return None
    data = list(values)
    count = len(data)
    avg = sum(data) / count
    data.sort()
    idx = int(math.ceil(0.95 * count)) - 1
    if idx < 0:
        idx = 0
    elif idx >= count:
        idx = count - 1
    p95 = data[idx]
    return avg, p95, count


class LatencyProfiler:
    """Collect rolling latency stats for rx/preprocess/publish."""

    def __init__(
        self,
        enabled: bool = False,
        sample_size: int = _DEFAULT_SAMPLE_SIZE,
        log_interval_s: float = _DEFAULT_LOG_INTERVAL_S,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._enabled = bool(enabled)
        self._logger = logger or logging.getLogger(__name__)
        self._sample_size = _sanitize_sample_size(sample_size, _DEFAULT_SAMPLE_SIZE)
        self._log_interval_s = _sanitize_interval(log_interval_s, _DEFAULT_LOG_INTERVAL_S)
        self._next_trace_id = 1

        if not self._enabled:
            self._traces = None
            self._rx_to_pre = None
            self._pre_to_pub = None
            self._rx_to_pub = None
            self._next_log_time = None
            self._max_traces = 0
            return

        self._traces: Dict[int, _Trace] = {}
        self._rx_to_pre: Deque[float] = deque(maxlen=self._sample_size)
        self._pre_to_pub: Deque[float] = deque(maxlen=self._sample_size)
        self._rx_to_pub: Deque[float] = deque(maxlen=self._sample_size)
        self._next_log_time = time.monotonic() + self._log_interval_s
        self._max_traces = max(self._sample_size * _TRACE_GROWTH_MULTIPLIER, _MIN_TRACE_CAP)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def mark_rx(self) -> Optional[int]:
        """Mark receipt time and return trace id when enabled."""
        if not self._enabled:
            return None
        trace_id = self._next_trace_id
        self._next_trace_id += 1

        traces = self._traces
        if traces is None:
            return None

        traces[trace_id] = _Trace(rx_time=time.monotonic())
        if len(traces) > self._max_traces:
            traces.popitem(last=False)
        return trace_id

    def mark_preprocess(self, trace_id: Optional[int]) -> None:
        """Mark preprocess completion time for a trace id."""
        if not self._enabled or trace_id is None:
            return
        traces = self._traces
        if traces is None:
            return
        trace = traces.get(trace_id)
        if trace is None:
            return
        trace.preprocess_time = time.monotonic()

    def mark_publish(self, trace_id: Optional[int]) -> None:
        """Mark publish completion and update rolling stats."""
        if not self._enabled or trace_id is None:
            return
        traces = self._traces
        if traces is None:
            return
        trace = traces.pop(trace_id, None)
        if trace is None:
            return

        now = time.monotonic()
        rx_time = trace.rx_time
        rx_to_pub = now - rx_time
        if rx_to_pub >= 0:
            self._rx_to_pub.append(rx_to_pub)

        pre_time = trace.preprocess_time
        if pre_time is not None:
            rx_to_pre = pre_time - rx_time
            pre_to_pub = now - pre_time
            if rx_to_pre >= 0:
                self._rx_to_pre.append(rx_to_pre)
            if pre_to_pub >= 0:
                self._pre_to_pub.append(pre_to_pub)

        self._maybe_log(now)

    def _maybe_log(self, now: float) -> None:
        next_log_time = self._next_log_time
        if next_log_time is None or now < next_log_time:
            return
        self._next_log_time = now + self._log_interval_s
        self._log_stats()

    def _log_stats(self) -> None:
        if not self._enabled:
            return

        parts = []
        rx_to_pre_stats = _compute_stats(self._rx_to_pre)
        if rx_to_pre_stats is not None:
            avg, p95, count = rx_to_pre_stats
            parts.append(
                f"rx->pre avg={_format_ms(avg)} p95={_format_ms(p95)} n={count}"
            )

        pre_to_pub_stats = _compute_stats(self._pre_to_pub)
        if pre_to_pub_stats is not None:
            avg, p95, count = pre_to_pub_stats
            parts.append(
                f"pre->pub avg={_format_ms(avg)} p95={_format_ms(p95)} n={count}"
            )

        rx_to_pub_stats = _compute_stats(self._rx_to_pub)
        if rx_to_pub_stats is not None:
            avg, p95, count = rx_to_pub_stats
            parts.append(
                f"rx->pub avg={_format_ms(avg)} p95={_format_ms(p95)} n={count}"
            )

        if not parts:
            return

        self._logger.info("ROS bridge latency: %s", "; ".join(parts))
