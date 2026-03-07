"""Tests for ComboMetricsStore fail-safe behavior."""
from __future__ import annotations

import sqlite3

from packages.agencyu.marketing.stores.combo_metrics_store import ComboMetricsStore


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    return conn


def test_returns_none_when_view_missing():
    """If the materialized view doesn't exist, store returns None (fail safe)."""
    conn = _mem_db()
    store = ComboMetricsStore(conn)
    result = store.get_combo_metrics(combo_id="combo_1", brand="cutmv", window="last_24h")
    assert result is None


def test_returns_none_for_unknown_window():
    """Unknown window strings return None immediately."""
    conn = _mem_db()
    store = ComboMetricsStore(conn)
    result = store.get_combo_metrics(combo_id="combo_1", brand="cutmv", window="last_999d")
    assert result is None


def test_returns_none_when_row_missing():
    """If view exists but no matching row, returns None."""
    conn = _mem_db()
    # Create the view as a simple table for testing
    conn.execute(
        """CREATE TABLE mv_combo_metrics_last_24h (
            brand TEXT, combo_id TEXT, spend_usd REAL, conversions INTEGER,
            cpa REAL, roas REAL, fatigue_score REAL, calls_showed INTEGER,
            pipeline_quality REAL, close_rate REAL
        )"""
    )
    store = ComboMetricsStore(conn)
    result = store.get_combo_metrics(combo_id="combo_99", brand="cutmv", window="last_24h")
    assert result is None


def test_returns_dict_when_row_exists():
    """Happy path: view exists, row exists, returns dict."""
    conn = _mem_db()
    conn.execute(
        """CREATE TABLE mv_combo_metrics_last_24h (
            brand TEXT, combo_id TEXT, spend_usd REAL, conversions INTEGER,
            cpa REAL, roas REAL, fatigue_score REAL, calls_showed INTEGER,
            pipeline_quality REAL, close_rate REAL
        )"""
    )
    conn.execute(
        "INSERT INTO mv_combo_metrics_last_24h VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("cutmv", "combo_1", 100.0, 5, 20.0, 3.5, 0.2, 12, 0.75, 0.08),
    )
    store = ComboMetricsStore(conn)
    result = store.get_combo_metrics(combo_id="combo_1", brand="cutmv", window="last_24h")
    assert result is not None
    assert isinstance(result, dict)
    assert result["spend_usd"] == 100.0
    assert result["conversions"] == 5
    assert result["calls_showed"] == 12
    assert result["close_rate"] == 0.08


def test_prev_2d_window():
    """prev_2d maps to correct view."""
    conn = _mem_db()
    conn.execute(
        """CREATE TABLE mv_combo_metrics_prev_2d (
            brand TEXT, combo_id TEXT, spend_usd REAL, conversions INTEGER,
            cpa REAL, roas REAL, fatigue_score REAL, calls_showed INTEGER,
            pipeline_quality REAL, close_rate REAL
        )"""
    )
    conn.execute(
        "INSERT INTO mv_combo_metrics_prev_2d VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("fulldigital", "combo_2", 200.0, 10, 20.0, 4.0, 0.1, 20, 0.80, 0.10),
    )
    store = ComboMetricsStore(conn)
    result = store.get_combo_metrics(combo_id="combo_2", brand="fulldigital", window="prev_2d")
    assert result is not None
    assert result["spend_usd"] == 200.0
