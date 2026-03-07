from __future__ import annotations

import sqlite3

from packages.common.db import init_schema
from packages.domain.nurture import (
    cancel_pending_nurture,
    get_pending_nurture_count,
    schedule_pre_call_nurture,
    should_stop_nurture,
)


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


def test_schedule_pre_call_nurture_dry_run():
    conn = _mem_db()
    result = schedule_pre_call_nurture(
        conn,
        booking_id="booking_001",
        contact_key="ghl_123",
        segment="starter",
    )
    assert result["ok"] is True
    assert result["count"] == 4  # 4 default nurture steps
    assert all(a["action"] == "would_schedule_nurture" for a in result["actions"])


def test_get_pending_nurture_count_empty():
    conn = _mem_db()
    assert get_pending_nurture_count(conn) == 0


def test_should_stop_nurture_no_signals():
    conn = _mem_db()
    assert should_stop_nurture(conn, contact_key="ghl_123") is None


def test_should_stop_nurture_booking_cancelled():
    conn = _mem_db()
    conn.execute(
        "INSERT INTO setter_activity_log (activity_id, setter_id, activity_type, contact_key, details_json, ts) VALUES (?, ?, ?, ?, ?, ?)",
        ("act_1", "setter_1", "booking_cancelled", "ghl_123", "{}", "2026-01-01T00:00:00"),
    )
    conn.commit()
    assert should_stop_nurture(conn, contact_key="ghl_123") == "booking_cancelled"


def test_cancel_pending_nurture_dry_run():
    conn = _mem_db()
    result = cancel_pending_nurture(conn, contact_key="ghl_123", reason="test")
    assert result["action"] == "would_cancel_nurture"
