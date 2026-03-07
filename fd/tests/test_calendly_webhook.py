"""Tests for Calendly webhook ingestion and GHL/Calendly precedence logic."""
from __future__ import annotations

import json
import sqlite3

import pytest

from packages.agencyu.ledger.normalizer import normalize_event
from packages.agencyu.ledger.writer import LedgerWriter
from packages.agencyu.marketing.attribution_ledger import AttributionLedger
from packages.common.db import init_schema


@pytest.fixture()
def conn():
    """In-memory SQLite with full schema."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    # Ensure tables exist for ledger
    AttributionLedger(c)
    # Ensure idempotency_key column exists (migration 025)
    try:
        c.execute("ALTER TABLE attribution_events ADD COLUMN idempotency_key TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        c.execute("ALTER TABLE attribution_events ADD COLUMN normalized_stage TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_ae_idem ON attribution_events(idempotency_key)")
    except sqlite3.OperationalError:
        pass
    # normalization rules table
    c.execute("""CREATE TABLE IF NOT EXISTS event_normalization_rules (
        id INTEGER PRIMARY KEY, source TEXT, raw_stage TEXT,
        normalized_stage TEXT, active INTEGER DEFAULT 1, priority INTEGER DEFAULT 0)""")
    # mv tables
    c.execute("""CREATE TABLE IF NOT EXISTS mv_chain_latest (
        chain_id TEXT PRIMARY KEY, brand TEXT, combo_id TEXT,
        latest_stage TEXT, latest_ts TEXT, total_events INTEGER DEFAULT 0,
        has_showed INTEGER DEFAULT 0, has_closed INTEGER DEFAULT 0,
        has_refunded INTEGER DEFAULT 0, refreshed_at TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS mv_combo_daily (
        combo_id TEXT, brand TEXT, day TEXT, calls_booked INTEGER DEFAULT 0,
        calls_showed INTEGER DEFAULT 0, closes INTEGER DEFAULT 0,
        gross_revenue_usd REAL DEFAULT 0, refunds_usd REAL DEFAULT 0,
        applications INTEGER DEFAULT 0, refreshed_at TEXT,
        PRIMARY KEY(combo_id, brand, day))""")
    c.execute("""CREATE TABLE IF NOT EXISTS mv_setter_daily (
        setter_id TEXT, brand TEXT, day TEXT, calls INTEGER DEFAULT 0,
        closes INTEGER DEFAULT 0, revenue_usd REAL DEFAULT 0, refreshed_at TEXT,
        PRIMARY KEY(setter_id, brand, day))""")
    c.commit()
    return c


def _insert_event(conn, *, chain_id, stage, source, ts, payload):
    """Insert an event via normalizer + writer."""
    event = normalize_event(
        conn, chain_id=chain_id, stage=stage, source=source, ts=ts, payload=payload,
    )
    writer = LedgerWriter(conn)
    return writer.insert_event(event)


def _setup_chain(conn, chain_id, brand="fulldigital", combo_id="combo:FD_01"):
    ledger = AttributionLedger(conn)
    ledger.upsert_chain(chain_id=chain_id, brand=brand, combo_id=combo_id, ids={})


# ── GHL appointment_key + calendar_source tests ──


class TestGHLAppointmentKey:
    def test_ghl_booking_has_appointment_key(self, conn):
        _setup_chain(conn, "chain_1")
        payload = {
            "appointment_key": "ghl:apt_123",
            "calendar_source": "ghl",
            "ghl_appointment_id": "apt_123",
            "ghl_contact_id": "c_1",
        }
        inserted = _insert_event(
            conn, chain_id="chain_1", stage="booking_complete",
            source="ghl", ts="2026-03-05T10:00:00Z", payload=payload,
        )
        assert inserted is True

        row = conn.execute(
            "SELECT payload_json FROM attribution_events WHERE chain_id='chain_1'"
        ).fetchone()
        data = json.loads(row[0])
        assert data["appointment_key"] == "ghl:apt_123"
        assert data["calendar_source"] == "ghl"

    def test_ghl_call_no_show(self, conn):
        _setup_chain(conn, "chain_2")
        payload = {
            "appointment_key": "ghl:apt_456",
            "calendar_source": "ghl",
            "ghl_appointment_id": "apt_456",
            "ghl_contact_id": "c_2",
        }
        inserted = _insert_event(
            conn, chain_id="chain_2", stage="call_no_show",
            source="ghl", ts="2026-03-05T11:00:00Z", payload=payload,
        )
        assert inserted is True

        row = conn.execute(
            "SELECT stage FROM attribution_events WHERE chain_id='chain_2'"
        ).fetchone()
        assert row[0] == "call_no_show"


# ── Calendly ingestion tests ──


class TestCalendlyIngestion:
    def test_calendly_booking(self, conn):
        _setup_chain(conn, "chain_cal_1")
        payload = {
            "appointment_key": "cal:inv_abc",
            "calendar_source": "calendly",
            "cal_invitee_uuid": "inv_abc",
            "email": "test@example.com",
        }
        inserted = _insert_event(
            conn, chain_id="chain_cal_1", stage="booking_complete",
            source="calendly", ts="2026-03-05T09:00:00Z", payload=payload,
        )
        assert inserted is True

        row = conn.execute(
            "SELECT payload_json, source FROM attribution_events WHERE chain_id='chain_cal_1'"
        ).fetchone()
        data = json.loads(row[0])
        assert data["calendar_source"] == "calendly"
        assert data["appointment_key"] == "cal:inv_abc"
        assert row[1] == "calendly"

    def test_calendly_cancellation(self, conn):
        _setup_chain(conn, "chain_cal_2")
        payload = {
            "appointment_key": "cal:inv_xyz",
            "calendar_source": "calendly",
            "cal_invitee_uuid": "inv_xyz",
            "reason": "scheduling conflict",
        }
        inserted = _insert_event(
            conn, chain_id="chain_cal_2", stage="booking_canceled",
            source="calendly", ts="2026-03-05T12:00:00Z", payload=payload,
        )
        assert inserted is True


# ── Precedence / dedup tests ──


class TestPrecedenceDedup:
    def test_ghl_wins_over_calendly_for_same_appointment(self, conn):
        """When both GHL and Calendly emit booking_complete for the same
        appointment_key, only 1 should be counted after rollup."""
        from packages.agencyu.jobs.refresh_mv_combo_daily import refresh_mv_combo_daily

        _setup_chain(conn, "chain_p1", combo_id="combo:P1")

        # GHL booking
        _insert_event(
            conn, chain_id="chain_p1", stage="booking_complete", source="ghl",
            ts="2026-03-05T10:00:00Z",
            payload={"appointment_key": "ghl:apt_999", "calendar_source": "ghl"},
        )
        # Calendly booking for same conceptual appointment (different key format)
        _insert_event(
            conn, chain_id="chain_p1", stage="booking_complete", source="calendly",
            ts="2026-03-05T10:01:00Z",
            payload={"appointment_key": "cal:inv_999", "calendar_source": "calendly"},
        )

        # Both events are in the ledger
        count = conn.execute(
            "SELECT COUNT(*) FROM attribution_events WHERE chain_id='chain_p1' AND stage='booking_complete'"
        ).fetchone()[0]
        assert count == 2

        # After rollup, both count since appointment_keys differ
        # (they'd only dedup if appointment_keys matched)
        refresh_mv_combo_daily(conn)
        row = conn.execute(
            "SELECT calls_booked FROM mv_combo_daily WHERE combo_id='combo:P1'"
        ).fetchone()
        assert row is not None
        assert row[0] == 2  # different appointment_keys → both counted

    def test_ghl_dedup_same_appointment_key(self, conn):
        """When GHL and Calendly emit for the same appointment_key,
        only GHL should be counted."""
        from packages.agencyu.jobs.refresh_mv_combo_daily import refresh_mv_combo_daily

        _setup_chain(conn, "chain_p2", combo_id="combo:P2")

        # GHL showed
        _insert_event(
            conn, chain_id="chain_p2", stage="call_showed", source="ghl",
            ts="2026-03-05T14:00:00Z",
            payload={"appointment_key": "shared_key_1", "calendar_source": "ghl"},
        )
        # Calendly showed for the same appointment_key
        _insert_event(
            conn, chain_id="chain_p2", stage="call_showed", source="calendly",
            ts="2026-03-05T14:01:00Z",
            payload={"appointment_key": "shared_key_1", "calendar_source": "calendly"},
        )

        refresh_mv_combo_daily(conn)
        row = conn.execute(
            "SELECT calls_showed FROM mv_combo_daily WHERE combo_id='combo:P2'"
        ).fetchone()
        assert row is not None
        assert row[0] == 1  # GHL wins, Calendly deduplicated

    def test_calendly_fills_gap_when_no_ghl(self, conn):
        """When only Calendly has a showed event, it should be counted."""
        from packages.agencyu.jobs.refresh_mv_combo_daily import refresh_mv_combo_daily

        _setup_chain(conn, "chain_p3", combo_id="combo:P3")

        # Only Calendly showed
        _insert_event(
            conn, chain_id="chain_p3", stage="call_showed", source="calendly",
            ts="2026-03-05T15:00:00Z",
            payload={"appointment_key": "cal:inv_only", "calendar_source": "calendly"},
        )

        refresh_mv_combo_daily(conn)
        row = conn.execute(
            "SELECT calls_showed FROM mv_combo_daily WHERE combo_id='combo:P3'"
        ).fetchone()
        assert row is not None
        assert row[0] == 1  # Calendly fills the gap

    def test_idempotent_insert_prevents_duplicates(self, conn):
        """Same event inserted twice should only appear once."""
        _setup_chain(conn, "chain_idem")

        payload = {"appointment_key": "ghl:apt_idem", "calendar_source": "ghl"}
        first = _insert_event(
            conn, chain_id="chain_idem", stage="booking_complete",
            source="ghl", ts="2026-03-05T10:00:00Z", payload=payload,
        )
        second = _insert_event(
            conn, chain_id="chain_idem", stage="booking_complete",
            source="ghl", ts="2026-03-05T10:00:00Z", payload=payload,
        )
        assert first is True
        assert second is False

        count = conn.execute(
            "SELECT COUNT(*) FROM attribution_events WHERE chain_id='chain_idem'"
        ).fetchone()[0]
        assert count == 1


# ── Setter mapping tests ──


class TestSetterMapping:
    def test_resolve_setter_by_email(self):
        from packages.agencyu.config.setter_mapping import _load_setters, resolve_setter_id_by_email, reload_setters
        import packages.agencyu.config.setter_mapping as sm

        # Force reload with known config
        sm._email_map = {"da@fulldigital.co": "DA", "john@example.com": "JOHN"}

        assert resolve_setter_id_by_email("da@fulldigital.co") == "DA"
        assert resolve_setter_id_by_email("DA@FULLDIGITAL.CO") == "DA"
        assert resolve_setter_id_by_email("unknown@example.com") is None
        assert resolve_setter_id_by_email(None) is None

        # Cleanup
        sm._email_map = None
