"""Tests for AgencyOS v11: Audit mirror hardening — circuit breaker, SQLite dedupe columns,
paginated Notion scan, mirror tracking."""

from __future__ import annotations

import json
import sqlite3
import time
from unittest.mock import MagicMock, patch

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


def _insert_audit_row(conn, *, id_="a1", ts="2025-06-01T12:00:00Z", corr="corr1",
                       system="openclaw", action="heal", result="ok",
                       target=None, stop_reason=None, payload_json=None, notes=None):
    conn.execute(
        "INSERT INTO audit_logs (id, ts, correlation_id, system, action, result, target, stop_reason, payload_json, notes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (id_, ts, corr, system, action, result, target, stop_reason, payload_json, notes),
    )
    conn.commit()


# ── Migration / schema tests ──


class TestMirrorColumns:
    def test_audit_logs_has_mirrored_columns(self, conn):
        """The new mirror tracking columns exist after init_schema."""
        _insert_audit_row(conn, id_="a1")
        row = conn.execute("SELECT mirrored_to_notion_at, mirrored_event_key FROM audit_logs WHERE id='a1'").fetchone()
        assert row["mirrored_to_notion_at"] is None
        assert row["mirrored_event_key"] is None

    def test_can_write_mirror_columns(self, conn):
        _insert_audit_row(conn, id_="a1")
        conn.execute(
            "UPDATE audit_logs SET mirrored_to_notion_at='2025-06-01T12:05:00Z', mirrored_event_key='key_abc' WHERE id='a1'"
        )
        conn.commit()
        row = conn.execute("SELECT mirrored_to_notion_at, mirrored_event_key FROM audit_logs WHERE id='a1'").fetchone()
        assert row["mirrored_to_notion_at"] == "2025-06-01T12:05:00Z"
        assert row["mirrored_event_key"] == "key_abc"

    def test_mirror_indexes_exist(self, conn):
        """Indexes on mirror columns should exist."""
        indexes = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_logs'"
        ).fetchall()
        names = {r[0] for r in indexes}
        assert "idx_audit_logs_mirrored" in names
        assert "idx_audit_logs_mirror_key" in names


# ── Circuit Breaker tests ──


class TestCircuitBreaker:
    def test_no_cooldown_by_default(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker(conn)
        active, until, reason = cb.cooldown_active()
        assert active is False

    def test_trip_on_threshold(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker, CircuitBreakerConfig

        cfg = CircuitBreakerConfig(window_seconds=900, error_threshold=3, cooldown_seconds=600)
        cb = CircuitBreaker(conn, cfg=cfg)

        tripped = cb.consider_trip(mirror_job_errors=3, reason="test_errors")
        assert tripped is True

        active, until, reason = cb.cooldown_active()
        assert active is True
        assert until is not None
        assert "test_errors" in reason

    def test_no_trip_below_threshold(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker, CircuitBreakerConfig

        cfg = CircuitBreakerConfig(window_seconds=900, error_threshold=5, cooldown_seconds=600)
        cb = CircuitBreaker(conn, cfg=cfg)

        tripped = cb.consider_trip(mirror_job_errors=2, reason="minor")
        assert tripped is False

    def test_trip_combines_recent_failures_and_job_errors(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker, CircuitBreakerConfig

        cfg = CircuitBreakerConfig(window_seconds=900, error_threshold=4, cooldown_seconds=600)
        cb = CircuitBreaker(conn, cfg=cfg)

        # Insert 3 recent notion failures
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for i in range(3):
            _insert_audit_row(conn, id_=f"fail{i}", system="notion", action="write", result="failed", ts=now_iso)

        # 3 recent + 1 job error = 4 >= threshold
        tripped = cb.consider_trip(mirror_job_errors=1, reason="combined")
        assert tripped is True

    def test_clear_resets_cooldown(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker, CircuitBreakerConfig

        cfg = CircuitBreakerConfig(error_threshold=1, cooldown_seconds=3600)
        cb = CircuitBreaker(conn, cfg=cfg)

        cb.consider_trip(mirror_job_errors=5, reason="test")
        active, _, _ = cb.cooldown_active()
        assert active is True

        cb.clear()
        active, _, _ = cb.cooldown_active()
        assert active is False

    def test_expired_cooldown_not_active(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker(conn)
        # Set cooldown to a past epoch
        cb._set(cb.KEY_COOLDOWN, str(int(time.time()) - 100))
        active, _, _ = cb.cooldown_active()
        assert active is False

    def test_already_cooling_down_returns_true(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker, CircuitBreakerConfig

        cfg = CircuitBreakerConfig(error_threshold=1, cooldown_seconds=3600)
        cb = CircuitBreaker(conn, cfg=cfg)

        # Trip it
        cb.consider_trip(mirror_job_errors=5, reason="first")

        # Calling again should return True without re-tripping
        result = cb.consider_trip(mirror_job_errors=0, reason="second")
        assert result is True


# ── SQLite mirror tracking in writer ──


class TestSQLiteMirrorTracking:
    def test_mark_mirrored_updates_row(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok")

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        # Fetch the row with rowid
        rows = writer._fetch_recent_audit_logs(limit=10)
        assert len(rows) == 1

        writer._mark_mirrored(rows[0], "key_123", note="test")

        row = conn.execute("SELECT mirrored_to_notion_at, mirrored_event_key FROM audit_logs WHERE id='a1'").fetchone()
        assert row["mirrored_to_notion_at"] is not None
        assert row["mirrored_event_key"] == "key_123"

    def test_exclude_already_mirrored(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok")
        _insert_audit_row(conn, id_="a2", system="openclaw", action="verify", result="ok")

        # Mark a1 as mirrored
        conn.execute("UPDATE audit_logs SET mirrored_to_notion_at='2025-06-01T12:05:00Z' WHERE id='a1'")
        conn.commit()

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        rows = writer._fetch_recent_audit_logs(limit=10)
        filtered = writer._exclude_already_mirrored(rows)
        assert len(filtered) == 1
        assert filtered[0]["id"] == "a2"

    def test_live_run_marks_mirrored_after_success(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok",
                          corr="c1", ts="2025-06-01T12:00:00Z")

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_new"
        mock_api.query_database.return_value = {"results": []}

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False, notion_write_enabled=True, notion_write_lock=False,
        )
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        writer.run(correlation_id="corr_run")

        row = conn.execute("SELECT mirrored_to_notion_at, mirrored_event_key FROM audit_logs WHERE id='a1'").fetchone()
        assert row["mirrored_to_notion_at"] is not None
        assert row["mirrored_event_key"] is not None

    def test_live_run_marks_existing_as_mirrored(self, conn):
        """Rows that already exist in Notion should be marked mirrored in SQLite."""
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok",
                          corr="c1", ts="2025-06-01T12:00:00Z")

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False, notion_write_enabled=True, notion_write_lock=False,
        )
        # Compute expected event key
        writer_temp = NotionAuditWriter(conn, MagicMock(), cfg=cfg)
        row = {"ts": "2025-06-01T12:00:00Z", "system": "openclaw", "action": "heal",
               "result": "ok", "target": None, "correlation_id": "c1"}
        expected_key = writer_temp._event_key(row)

        mock_api = MagicMock()
        mock_api.query_database.return_value = {
            "results": [{
                "properties": {
                    "payload_json": {
                        "type": "rich_text",
                        "rich_text": [{"plain_text": json.dumps({"event_key": expected_key})}],
                    }
                }
            }]
        }

        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        result = writer.run(correlation_id="corr_dedup")

        assert result["skipped_existing"] == 1
        mock_api.create_page.assert_not_called()

        # The row should be marked as mirrored in SQLite
        db_row = conn.execute("SELECT mirrored_to_notion_at FROM audit_logs WHERE id='a1'").fetchone()
        assert db_row["mirrored_to_notion_at"] is not None

    def test_second_run_skips_mirrored_rows(self, conn):
        """A second run should skip rows that were mirrored in the first run."""
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok",
                          corr="c1", ts="2025-06-01T12:00:00Z")

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_new"
        mock_api.query_database.return_value = {"results": []}

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False, notion_write_enabled=True, notion_write_lock=False,
        )

        # First run: writes
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        r1 = writer.run(correlation_id="corr1")
        assert r1["written"] == 1

        # Second run: should skip because row is marked mirrored
        mock_api.reset_mock()
        mock_api.query_database.return_value = {"results": []}
        writer2 = NotionAuditWriter(conn, mock_api, cfg=cfg)
        r2 = writer2.run(correlation_id="corr2")
        assert r2["written"] == 0
        assert r2["candidate_count"] == 0  # excluded by _exclude_already_mirrored


# ── Paginated Notion scan tests ──


class TestPaginatedNotionScan:
    def test_paginates_multiple_pages(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()

        # Page 1: has_more=True
        page1 = {
            "results": [{
                "properties": {
                    "payload_json": {"type": "rich_text", "rich_text": [{"plain_text": json.dumps({"event_key": "key_1"})}]},
                }
            }],
            "has_more": True,
            "next_cursor": "cursor_2",
        }
        # Page 2: has_more=False
        page2 = {
            "results": [{
                "properties": {
                    "payload_json": {"type": "rich_text", "rich_text": [{"plain_text": json.dumps({"event_key": "key_2"})}]},
                }
            }],
            "has_more": False,
        }
        mock_api.query_database.side_effect = [page1, page2]

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x", notion_scan_max_pages=5)
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        keys = writer._fetch_existing_event_keys_from_notion()

        assert keys == {"key_1", "key_2"}
        assert mock_api.query_database.call_count == 2

    def test_respects_max_pages(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()
        call_count = {"n": 0}

        # Always return has_more=True
        def always_more(*args, **kwargs):
            call_count["n"] += 1
            return {
                "results": [{
                    "properties": {
                        "payload_json": {"type": "rich_text", "rich_text": [{"plain_text": json.dumps({"event_key": f"key_{call_count['n']}"})}]},
                    }
                }],
                "has_more": True,
                "next_cursor": f"cursor_{call_count['n'] + 1}",
            }
        mock_api.query_database.side_effect = always_more

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x", notion_scan_max_pages=3)
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        keys = writer._fetch_existing_event_keys_from_notion()

        # Should stop after max_pages (3) + 1 initial = at most 4 calls
        assert mock_api.query_database.call_count <= 4
        assert len(keys) >= 1

    def test_handles_api_error_on_first_page(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()
        mock_api.query_database.side_effect = RuntimeError("Notion down")

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        keys = writer._fetch_existing_event_keys_from_notion()

        assert keys == set()


# ── Circuit breaker integration with writer ──


class TestWriterCircuitBreaker:
    def test_run_blocked_by_cooldown(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok")

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False, notion_write_enabled=True, notion_write_lock=False,
            cb_error_threshold=1, cb_cooldown_seconds=3600,
        )
        mock_api = MagicMock()
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)

        # Manually trip the circuit breaker
        writer.cb.consider_trip(mirror_job_errors=5, reason="test_block")

        result = writer.run(correlation_id="corr_blocked")
        assert result["simulate"] is True
        assert "circuit_breaker_cooldown" in result["blocked_reason"]
        assert "circuit_breaker_cooldown_active" in result["warnings"]
        mock_api.create_page.assert_not_called()

    def test_run_trips_breaker_on_errors(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        # Insert enough rows to generate errors
        for i in range(6):
            _insert_audit_row(conn, id_=f"a{i}", system="openclaw", action="heal",
                              result="ok", corr=f"c{i}", ts=f"2025-06-01T12:{i:02d}:00Z")

        mock_api = MagicMock()
        mock_api.query_database.return_value = {"results": []}
        mock_api.create_page.side_effect = RuntimeError("Notion API error")

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False, notion_write_enabled=True, notion_write_lock=False,
            cb_error_threshold=3, cb_cooldown_seconds=1800,
        )
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        result = writer.run(correlation_id="corr_err")

        assert result["ok"] is False
        assert "circuit_breaker_tripped" in result.get("warnings", [])

        # Verify breaker is now active
        active, _, _ = writer.cb.cooldown_active()
        assert active is True


# ── Config with hardening fields ──


class TestHardenedConfig:
    def test_config_has_hardening_defaults(self):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig()
        assert cfg.notion_scan_max_pages == 6
        assert cfg.notion_scan_page_size == 100
        assert cfg.cb_window_seconds == 900
        assert cfg.cb_error_threshold == 6
        assert cfg.cb_cooldown_seconds == 1800

    def test_config_custom_hardening(self):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(
            notion_scan_max_pages=10,
            cb_error_threshold=2,
            cb_cooldown_seconds=600,
        )
        assert cfg.notion_scan_max_pages == 10
        assert cfg.cb_error_threshold == 2
        assert cfg.cb_cooldown_seconds == 600


# ── Simulation excludes already-mirrored ──


class TestSimulationExcludesMirrored:
    def test_simulate_excludes_mirrored_rows(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok")
        _insert_audit_row(conn, id_="a2", system="openclaw", action="verify", result="ok")

        # Mark a1 as mirrored
        conn.execute("UPDATE audit_logs SET mirrored_to_notion_at='2025-06-01T12:05:00Z' WHERE id='a1'")
        conn.commit()

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x", safe_mode=True)
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)
        result = writer.run(correlation_id="corr_sim")

        assert result["simulate"] is True
        # Only a2 should be a candidate
        assert result["candidate_count"] == 1
