"""Tests for AgencyOS v10: Enhanced Notion Audit Writer with dedupe, policy, simulation."""

from __future__ import annotations

import hashlib
import json
import sqlite3
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


# ── Config tests ──


class TestNotionAuditWriterConfig:
    def test_defaults(self):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig()
        assert cfg.safe_mode is True
        assert cfg.notion_write_enabled is False
        assert cfg.notion_write_lock is True
        assert cfg.system_audit_log_db_id == ""
        assert cfg.dedupe_bucket_seconds == 60
        assert cfg.max_writes_per_run == 25
        assert "failed" in cfg.mirror_results
        assert "blocked" in cfg.mirror_results

    def test_custom_config(self):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_123",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=False,
            max_writes_per_run=5,
        )
        assert cfg.system_audit_log_db_id == "db_123"
        assert cfg.safe_mode is False
        assert cfg.max_writes_per_run == 5


# ── Selection policy tests ──


class TestSelectionPolicy:
    def test_always_mirror_failures(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        assert writer._should_mirror({"system": "openclaw", "action": "random_thing", "result": "failed"}) is True
        assert writer._should_mirror({"system": "openclaw", "action": "random_thing", "result": "blocked"}) is True

    def test_mirror_action_prefixes(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        assert writer._should_mirror({"system": "openclaw", "action": "heal", "result": "ok"}) is True
        assert writer._should_mirror({"system": "notion", "action": "backup", "result": "ok"}) is True
        assert writer._should_mirror({"system": "trello", "action": "verify", "result": "ok"}) is True
        assert writer._should_mirror({"system": "openclaw", "action": "reconcile", "result": "ok"}) is True
        assert writer._should_mirror({"system": "openclaw", "action": "portal_heal", "result": "ok"}) is True
        assert writer._should_mirror({"system": "openclaw", "action": "bootstrap", "result": "ok"}) is True

    def test_skip_unknown_system(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        assert writer._should_mirror({"system": "unknown_sys", "action": "heal", "result": "ok"}) is False

    def test_skip_unmatched_action(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        assert writer._should_mirror({"system": "openclaw", "action": "random_crud", "result": "ok"}) is False


# ── Event key / dedupe tests ──


class TestEventKeyDedupe:
    def test_event_key_deterministic(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        row = {"ts": "2025-06-01T12:00:30Z", "system": "openclaw", "action": "heal",
               "result": "ok", "target": "workspace", "correlation_id": "corr1"}
        k1 = writer._event_key(row)
        k2 = writer._event_key(row)
        assert k1 == k2
        assert len(k1) == 40  # SHA1 hex

    def test_event_key_buckets_within_minute(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x", dedupe_bucket_seconds=60)
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        row1 = {"ts": "2025-06-01T12:00:10Z", "system": "openclaw", "action": "heal",
                "result": "ok", "target": "ws", "correlation_id": "c1"}
        row2 = {"ts": "2025-06-01T12:00:45Z", "system": "openclaw", "action": "heal",
                "result": "ok", "target": "ws", "correlation_id": "c1"}
        # Same minute bucket → same key
        assert writer._event_key(row1) == writer._event_key(row2)

    def test_event_key_different_across_minutes(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x", dedupe_bucket_seconds=60)
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        row1 = {"ts": "2025-06-01T12:00:10Z", "system": "openclaw", "action": "heal",
                "result": "ok", "target": "ws", "correlation_id": "c1"}
        row2 = {"ts": "2025-06-01T12:01:10Z", "system": "openclaw", "action": "heal",
                "result": "ok", "target": "ws", "correlation_id": "c1"}
        assert writer._event_key(row1) != writer._event_key(row2)

    def test_bucket_ts(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        b = writer._bucket_ts("2025-06-01T12:00:45Z", 60)
        assert b == "2025-06-01T12:00:00Z"

    def test_bucket_ts_fallback(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        b = writer._bucket_ts("bad-timestamp", 60)
        assert b == "bad-timestamp"[:16]


# ── Batch run tests ──


class TestBatchRun:
    def test_simulate_on_safe_mode(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x", safe_mode=True)
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        result = writer.run(correlation_id="corr_test")
        assert result["simulate"] is True
        assert result["blocked_reason"] == "SAFE_MODE=true"
        assert result["ok"] is True

    def test_simulate_on_write_disabled(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_x",
            safe_mode=False,
            notion_write_enabled=False,
        )
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        result = writer.run(correlation_id="corr_test")
        assert result["simulate"] is True
        assert result["blocked_reason"] == "NOTION_WRITE_ENABLED=false"

    def test_simulate_on_write_lock(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_x",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=True,
        )
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        result = writer.run(correlation_id="corr_test")
        assert result["simulate"] is True
        assert result["blocked_reason"] == "NOTION_WRITE_LOCK=true"

    def test_simulate_no_db_id(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=False,
        )
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        result = writer.run(correlation_id="corr_test")
        assert result["simulate"] is True
        assert result["blocked_reason"] == "no_system_audit_log_db_id"

    def test_simulate_returns_candidate_preview(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok")
        _insert_audit_row(conn, id_="a2", system="openclaw", action="random_crud", result="ok")
        _insert_audit_row(conn, id_="a3", system="openclaw", action="verify", result="failed")

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x", safe_mode=True)
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        result = writer.run(correlation_id="corr_test")
        assert result["simulate"] is True
        # "heal" and "verify" should match, "random_crud" should not
        assert result["candidate_count"] == 2
        assert len(result["preview"]) == 2

    def test_live_run_writes_to_notion(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok", corr="c1", ts="2025-06-01T12:00:00Z")

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_new"
        mock_api.query_database.return_value = {"results": []}

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=False,
        )
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        result = writer.run(correlation_id="corr_run")

        assert result["simulate"] is False
        assert result["ok"] is True
        assert result["written"] == 1
        mock_api.create_page.assert_called_once()

    def test_live_run_skips_existing_event_keys(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok", corr="c1", ts="2025-06-01T12:00:00Z")

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=False,
        )
        # Compute expected event key
        writer_temp = NotionAuditWriter(conn, MagicMock(), cfg=cfg)
        row = {"ts": "2025-06-01T12:00:00Z", "system": "openclaw", "action": "heal",
               "result": "ok", "target": None, "correlation_id": "c1"}
        expected_key = writer_temp._event_key(row)

        # Mock Notion to return the existing key
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

        assert result["written"] == 0
        assert result["skipped_existing"] == 1
        mock_api.create_page.assert_not_called()

    def test_live_run_respects_max_writes(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        # Insert more rows than max_writes_per_run
        for i in range(10):
            _insert_audit_row(
                conn, id_=f"a{i}", system="openclaw", action="heal",
                result="ok", corr=f"c{i}", ts=f"2025-06-01T12:{i:02d}:00Z",
            )

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_new"
        mock_api.query_database.return_value = {"results": []}

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=False,
            max_writes_per_run=3,
        )
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        result = writer.run(correlation_id="corr_max")

        assert result["written"] <= 3

    def test_live_run_dedupes_within_run(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        # Insert two rows with identical bucketed keys (same minute, same fields)
        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal",
                          result="ok", corr="c1", ts="2025-06-01T12:00:10Z")
        _insert_audit_row(conn, id_="a2", system="openclaw", action="heal",
                          result="ok", corr="c1", ts="2025-06-01T12:00:45Z")

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_new"
        mock_api.query_database.return_value = {"results": []}

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=False,
            dedupe_bucket_seconds=60,
        )
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        result = writer.run(correlation_id="corr_dedup2")

        # Both rows bucket to same key → only 1 write
        assert result["written"] == 1

    def test_live_run_handles_api_errors(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        _insert_audit_row(conn, id_="a1", system="openclaw", action="heal", result="ok", corr="c1")

        mock_api = MagicMock()
        mock_api.query_database.return_value = {"results": []}
        mock_api.create_page.side_effect = RuntimeError("Notion API error")

        cfg = NotionAuditWriterConfig(
            system_audit_log_db_id="db_audit",
            safe_mode=False,
            notion_write_enabled=True,
            notion_write_lock=False,
        )
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        result = writer.run(correlation_id="corr_err")

        assert result["ok"] is False
        assert result["written"] == 0
        assert len(result["errors"]) == 1


# ── Write property mapping tests ──


class TestWritePropertyMapping:
    def test_write_one_builds_correct_properties(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_123"

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_audit")
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)

        row = {
            "correlation_id": "corr_test",
            "system": "notion",
            "action": "backup",
            "result": "ok",
            "target": "notion_mirror",
            "stop_reason": None,
            "payload_json": None,
            "notes": "Manual backup",
            "ts": "2025-06-01T12:00:00Z",
        }
        event_key = writer._event_key(row)
        page_id = writer._write_one_to_notion(row, event_key=event_key)

        assert page_id == "page_123"
        call_kwargs = mock_api.create_page.call_args
        props = call_kwargs.kwargs.get("properties") or call_kwargs[1].get("properties") or call_kwargs[0][1]

        # Verify key properties
        assert props["Name"]["title"][0]["text"]["content"] == "backup"
        assert props["ts"]["date"]["start"] == "2025-06-01T12:00:00Z"
        assert props["system"]["select"]["name"] == "notion"
        assert props["result"]["select"]["name"] == "ok"
        assert props["system_managed"]["checkbox"] is True

        # payload_json should contain event_key
        pj_text = props["payload_json"]["rich_text"][0]["text"]["content"]
        pj = json.loads(pj_text)
        assert pj["event_key"] == event_key

        # notes should be set
        assert props["notes"]["rich_text"][0]["text"]["content"] == "Manual backup"

        # target should be set
        assert props["target"]["rich_text"][0]["text"]["content"] == "notion_mirror"

    def test_write_one_empty_optional_fields(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()
        mock_api.create_page.return_value = "page_456"

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_audit")
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)

        row = {
            "correlation_id": "corr2",
            "system": "openclaw",
            "action": "heal",
            "result": "ok",
            "target": None,
            "stop_reason": None,
            "notes": None,
            "ts": "2025-06-01T12:00:00Z",
        }
        writer._write_one_to_notion(row, event_key="key123")

        call_kwargs = mock_api.create_page.call_args
        props = call_kwargs.kwargs.get("properties") or call_kwargs[1].get("properties") or call_kwargs[0][1]

        # Empty optional fields should have empty rich_text arrays
        assert props["target"]["rich_text"] == []
        assert props["stop_reason"]["rich_text"] == []
        assert props["notes"]["rich_text"] == []


# ── Resolution tests ──


class TestResolution:
    def test_resolve_from_bindings(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        conn.execute(
            "INSERT INTO notion_bindings (id, binding_type, notion_object_id, created_at, updated_at) "
            "VALUES ('nb1', 'system_audit_log', 'db_from_binding', '2025-01-01', '2025-01-01')"
        )
        conn.commit()

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)
        assert writer.audit_log_db_id == "db_from_binding"

    def test_resolve_from_system_settings(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        conn.execute(
            "INSERT INTO system_settings (key, value, updated_at) VALUES ('system_audit_log_db_id', 'db_from_settings', '2025-01-01T00:00:00Z')"
        )
        conn.commit()

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)
        assert writer.audit_log_db_id == "db_from_settings"

    def test_explicit_db_id_takes_priority(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        conn.execute(
            "INSERT INTO notion_bindings (id, binding_type, notion_object_id, created_at, updated_at) "
            "VALUES ('nb1', 'system_audit_log', 'db_from_binding', '2025-01-01', '2025-01-01')"
        )
        conn.commit()

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_explicit")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)
        assert writer.audit_log_db_id == "db_explicit"


# ── Notion key extraction tests ──


class TestNotionKeyExtraction:
    def test_fetch_existing_keys(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()
        mock_api.query_database.return_value = {
            "results": [
                {
                    "properties": {
                        "payload_json": {
                            "type": "rich_text",
                            "rich_text": [{"plain_text": json.dumps({"event_key": "key_abc"})}],
                        }
                    }
                },
                {
                    "properties": {
                        "payload_json": {
                            "type": "rich_text",
                            "rich_text": [{"plain_text": json.dumps({"event_key": "key_def"})}],
                        }
                    }
                },
                {
                    "properties": {
                        "payload_json": {
                            "type": "rich_text",
                            "rich_text": [{"plain_text": "not json"}],
                        }
                    }
                },
            ]
        }

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        keys = writer._fetch_existing_event_keys_from_notion(window_hours=72)

        assert keys == {"key_abc", "key_def"}

    def test_fetch_keys_empty_db(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()
        mock_api.query_database.return_value = {"results": []}

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        keys = writer._fetch_existing_event_keys_from_notion()

        assert keys == set()

    def test_fetch_keys_no_db_id(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)
        keys = writer._fetch_existing_event_keys_from_notion()

        assert keys == set()

    def test_fetch_keys_api_failure_fallback(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        mock_api = MagicMock()
        mock_api.query_database.side_effect = RuntimeError("Notion down")

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, mock_api, cfg=cfg)
        keys = writer._fetch_existing_event_keys_from_notion()

        assert keys == set()


# ── Mirror job wrapper tests ──


class TestMirrorJobWrapper:
    def test_job_returns_result(self, conn):
        from packages.agencyu.jobs.mirror_audit_logs_to_notion import run_audit_mirror_job

        with patch("packages.agencyu.jobs.mirror_audit_logs_to_notion.NotionClient"), \
             patch("packages.agencyu.jobs.mirror_audit_logs_to_notion.NotionAPI"):
            result = run_audit_mirror_job(
                conn,
                correlation_id="corr_job",
                system_audit_log_db_id="db_test",
                safe_mode=True,
            )
            assert result["simulate"] is True
            assert result["ok"] is True

    def test_job_records_audit_entry(self, conn):
        from packages.agencyu.jobs.mirror_audit_logs_to_notion import run_audit_mirror_job

        with patch("packages.agencyu.jobs.mirror_audit_logs_to_notion.NotionClient"), \
             patch("packages.agencyu.jobs.mirror_audit_logs_to_notion.NotionAPI"):
            run_audit_mirror_job(
                conn,
                correlation_id="corr_audit_track",
                system_audit_log_db_id="db_test",
                safe_mode=True,
            )

        row = conn.execute(
            "SELECT * FROM audit_logs WHERE action='notion.mirror_audit_logs'"
        ).fetchone()
        assert row is not None
        assert row["system"] == "openclaw"
        assert row["result"] == "ok"


# ── get_rich_text helper tests ──


class TestGetRichText:
    def test_extracts_text(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        page = {
            "properties": {
                "payload_json": {
                    "type": "rich_text",
                    "rich_text": [{"plain_text": "hello world"}],
                }
            }
        }
        assert writer._get_rich_text(page, "payload_json") == "hello world"

    def test_returns_none_for_missing(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        assert writer._get_rich_text({"properties": {}}, "missing_prop") is None

    def test_returns_none_for_empty_rich_text(self, conn):
        from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig

        cfg = NotionAuditWriterConfig(system_audit_log_db_id="db_x")
        writer = NotionAuditWriter(conn, MagicMock(), cfg=cfg)

        page = {
            "properties": {
                "notes": {"type": "rich_text", "rich_text": []}
            }
        }
        assert writer._get_rich_text(page, "notes") is None
