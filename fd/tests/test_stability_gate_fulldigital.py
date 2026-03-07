"""Tests for StabilityGate Full Digital stricter definitions."""
from __future__ import annotations

from packages.agencyu.marketing.stability_gate import StabilityGate


class FakeStore:
    """Fake combo metrics store for testing."""

    def __init__(self, data: dict | None = None):
        self._data = data or {}

    def get_combo_metrics(self, *, combo_id: str, brand: str, window: str):
        return self._data.get(window)


def _base_metrics(**overrides):
    m = {
        "spend_usd": 100, "conversions": 5, "cpa": 20.0, "roas": 3.0,
        "fatigue_score": 0.2, "calls_showed": 15, "pipeline_quality": 0.75,
        "close_rate": 0.10,
    }
    m.update(overrides)
    return m


def _policy(**fd_overrides):
    fd = {"min_calls_observed": 10, "min_pipeline_quality": 0.60, "min_close_rate": 0.05}
    fd.update(fd_overrides)
    return {
        "stability_gate": {
            "min_spend_usd": 30, "min_conversions": 2,
            "max_cpa_increase_ratio": 1.25, "min_roas_ratio_of_baseline": 0.85,
            "max_fatigue_score": 0.70, "lookback_days": 2,
            "fulldigital": fd,
        }
    }


def test_fd_passes_when_calls_showed_and_quality_ok():
    """Full Digital passes when calls_showed >= min and quality/close are good."""
    store = FakeStore({
        "last_24h": _base_metrics(calls_showed=15, pipeline_quality=0.75, close_rate=0.10),
        "prev_2d": _base_metrics(),
    })
    gate = StabilityGate(policy=_policy(), combo_metrics_store=store)
    result = gate.evaluate(brand="fulldigital", combo_id="combo_1")
    assert result.ok is True


def test_fd_fails_on_low_pipeline_quality():
    """Full Digital fails when pipeline quality is below minimum."""
    store = FakeStore({
        "last_24h": _base_metrics(calls_showed=15, pipeline_quality=0.40),
        "prev_2d": _base_metrics(),
    })
    gate = StabilityGate(policy=_policy(), combo_metrics_store=store)
    result = gate.evaluate(brand="fulldigital", combo_id="combo_1")
    assert result.ok is False
    assert any("Pipeline quality" in r for r in result.reasons)


def test_fd_fails_on_low_close_rate():
    """Full Digital fails when close rate (net paid only) is below minimum."""
    store = FakeStore({
        "last_24h": _base_metrics(calls_showed=15, close_rate=0.02),
        "prev_2d": _base_metrics(),
    })
    gate = StabilityGate(policy=_policy(), combo_metrics_store=store)
    result = gate.evaluate(brand="fulldigital", combo_id="combo_1")
    assert result.ok is False
    assert any("net paid only" in r for r in result.reasons)


def test_fd_skips_checks_when_insufficient_calls():
    """When calls_showed < min_calls, FD checks are skipped (not enough data)."""
    store = FakeStore({
        "last_24h": _base_metrics(calls_showed=3, pipeline_quality=0.10, close_rate=0.001),
        "prev_2d": _base_metrics(),
    })
    gate = StabilityGate(policy=_policy(), combo_metrics_store=store)
    result = gate.evaluate(brand="fulldigital", combo_id="combo_1")
    # Should NOT fail on pipeline/close because calls_showed < min
    assert not any("Pipeline quality" in r for r in result.reasons)
    assert not any("Close rate" in r for r in result.reasons)


def test_fd_uses_calls_showed_not_booked():
    """The gate reads calls_showed, not calls_observed or calls_booked."""
    # If the metric only has calls_showed=15, the gate should use it
    metrics = _base_metrics(calls_showed=15, pipeline_quality=0.75, close_rate=0.10)
    # Remove any old key to prove it doesn't use calls_observed
    metrics.pop("calls_observed", None)

    store = FakeStore({"last_24h": metrics, "prev_2d": _base_metrics()})
    gate = StabilityGate(policy=_policy(), combo_metrics_store=store)
    result = gate.evaluate(brand="fulldigital", combo_id="combo_1")
    assert result.ok is True


def test_no_store_returns_fail_safe():
    """With no store (None), the gate fails safe."""
    gate = StabilityGate(policy=_policy(), combo_metrics_store=None)
    result = gate.evaluate(brand="fulldigital", combo_id="combo_1")
    assert result.ok is False
    assert any("Insufficient" in r for r in result.reasons)
