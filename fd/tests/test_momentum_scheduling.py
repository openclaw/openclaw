from __future__ import annotations

import sqlite3

from packages.common.db import init_schema
from packages.domain.momentum import (
    generate_sprint_cadence,
    get_pending_momentum_count,
    schedule_momentum_sprint,
)


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


def test_generate_sprint_cadence_default():
    cadence = generate_sprint_cadence(start_date="2026-03-01T00:00:00")
    assert len(cadence) == 4  # MAX_TOUCHES_PER_SPRINT = 4
    assert cadence[0]["touch_number"] == 1
    assert cadence[0]["touch_type"] == "re_engage"
    assert cadence[-1]["touch_type"] == "direct_cta"


def test_generate_sprint_cadence_custom():
    cadence = generate_sprint_cadence(
        start_date="2026-03-01T00:00:00",
        sprint_days=7,
        touches_per_week=2,
    )
    # With 2 touches/week = 3.5 days between, in 7 days = 2-3 touches
    assert len(cadence) >= 2
    assert cadence[0]["day_offset"] == 0


def test_schedule_momentum_sprint_dry_run():
    conn = _mem_db()
    contacts = [
        {"contact_key": "ghl_001"},
        {"contact_key": "ghl_002"},
    ]
    result = schedule_momentum_sprint(
        conn,
        campaign_id="camp_001",
        contacts=contacts,
        start_date="2026-03-01T00:00:00",
    )
    assert result["ok"] is True
    # Each contact gets 4 touches (MAX_TOUCHES_PER_SPRINT)
    assert result["scheduled"] == 8


def test_schedule_momentum_sprint_skips_empty_contact():
    conn = _mem_db()
    contacts = [{"contact_key": ""}, {"no_key": True}]
    result = schedule_momentum_sprint(
        conn,
        campaign_id="camp_002",
        contacts=contacts,
        start_date="2026-03-01T00:00:00",
    )
    assert result["skipped"] == 2
    assert result["scheduled"] == 0


def test_get_pending_momentum_count_empty():
    conn = _mem_db()
    assert get_pending_momentum_count(conn) == 0
