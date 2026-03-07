"""Tests for AgencyOS v12: SystemState helper, SystemKeys, push_recent_stop,
and /admin/system/health endpoint."""

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


# ── SystemState core accessors ──


class TestSystemStateStr:
    def test_get_str_default(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        assert state.get_str("missing_key") is None
        assert state.get_str("missing_key", default="fallback") == "fallback"

    def test_set_and_get_str(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_str("test_key", "hello")
        assert state.get_str("test_key") == "hello"

    def test_set_overwrites(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_str("key1", "v1")
        state.set_str("key1", "v2")
        assert state.get_str("key1") == "v2"

    def test_get_updated_at(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_str("tracked", "val")
        ts = state.get_updated_at("tracked")
        assert ts is not None
        assert "T" in ts  # ISO format

    def test_get_updated_at_missing(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        assert state.get_updated_at("no_such_key") is None


class TestSystemStateInt:
    def test_get_int_default(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        assert state.get_int("missing") is None
        assert state.get_int("missing", default=42) == 42

    def test_set_and_get_int(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_int("count", 99)
        assert state.get_int("count") == 99

    def test_get_int_non_numeric(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_str("bad_int", "not_a_number")
        assert state.get_int("bad_int", default=0) == 0


class TestSystemStateBool:
    def test_get_bool_default(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        assert state.get_bool("missing") is False
        assert state.get_bool("missing", default=True) is True

    def test_set_and_get_bool_true(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_bool("flag", True)
        assert state.get_bool("flag") is True

    def test_set_and_get_bool_false(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_bool("flag", False)
        assert state.get_bool("flag") is False

    def test_truthy_variants(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        for val in ("1", "true", "yes", "on", "True", "YES"):
            state.set_str("flag", val)
            assert state.get_bool("flag") is True

    def test_falsy_variants(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        for val in ("0", "false", "no", "off", ""):
            state.set_str("flag", val)
            assert state.get_bool("flag") is False


class TestSystemStateJson:
    def test_get_json_default(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        assert state.get_json("missing") == {}
        assert state.get_json("missing", default={"a": 1}) == {"a": 1}

    def test_set_and_get_json(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_json("config", {"x": 1, "y": [2, 3]})
        result = state.get_json("config")
        assert result["x"] == 1
        assert result["y"] == [2, 3]

    def test_get_json_invalid_json(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_str("bad_json", "not json {{{")
        assert state.get_json("bad_json") == {}

    def test_get_json_non_dict(self, conn):
        from packages.agencyu.services.system_state import SystemState

        state = SystemState(conn)
        state.set_str("array", json.dumps([1, 2, 3]))
        assert state.get_json("array") == {}


# ── SystemKeys ──


class TestSystemKeys:
    def test_keys_are_strings(self):
        from packages.agencyu.services.system_state import SystemKeys

        assert isinstance(SystemKeys.NOTION_AUDIT_MIRROR_COOLDOWN_UNTIL_EPOCH, str)
        assert isinstance(SystemKeys.LAST_RECONCILE_SUCCESS_AT, str)
        assert isinstance(SystemKeys.RECENT_JOB_STOPS_JSON, str)
        assert isinstance(SystemKeys.QUEUE_DEPTH_SCHEDULED_ACTIONS, str)


# ── push_recent_stop ──


class TestPushRecentStop:
    def test_push_adds_item(self, conn):
        from packages.agencyu.services.system_state import SystemState, SystemKeys, push_recent_stop

        state = SystemState(conn)
        push_recent_stop(state, {"ts": "2025-06-01T12:00:00Z", "job": "mirror", "reason": "cooldown"})

        buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON)
        assert len(buf["items"]) == 1
        assert buf["items"][0]["job"] == "mirror"

    def test_push_prepends_newest_first(self, conn):
        from packages.agencyu.services.system_state import SystemState, SystemKeys, push_recent_stop

        state = SystemState(conn)
        push_recent_stop(state, {"ts": "t1", "job": "first", "reason": "r1"})
        push_recent_stop(state, {"ts": "t2", "job": "second", "reason": "r2"})

        buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON)
        assert buf["items"][0]["job"] == "second"
        assert buf["items"][1]["job"] == "first"

    def test_push_respects_max_items(self, conn):
        from packages.agencyu.services.system_state import SystemState, SystemKeys, push_recent_stop

        state = SystemState(conn)
        for i in range(10):
            push_recent_stop(state, {"ts": f"t{i}", "job": f"j{i}"}, max_items=5)

        buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON)
        assert len(buf["items"]) == 5
        assert buf["items"][0]["job"] == "j9"  # Most recent


# ── Circuit breaker integration (pushes stop reason on trip) ──


class TestCircuitBreakerPushesStop:
    def test_trip_pushes_to_ring_buffer(self, conn):
        from packages.agencyu.services.circuit_breaker import CircuitBreaker, CircuitBreakerConfig
        from packages.agencyu.services.system_state import SystemState, SystemKeys

        cfg = CircuitBreakerConfig(error_threshold=1, cooldown_seconds=600)
        cb = CircuitBreaker(conn, cfg=cfg)

        cb.consider_trip(mirror_job_errors=5, reason="test_trip")

        state = SystemState(conn)
        buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON)
        items = buf.get("items", [])
        assert len(items) >= 1
        assert items[0]["job"] == "circuit_breaker"
        assert "test_trip" in items[0]["reason"]


# ── Mirror job integration (pushes stop reason when blocked) ──


class TestMirrorJobPushesStop:
    def test_job_pushes_stop_on_safe_mode(self, conn):
        from packages.agencyu.jobs.mirror_audit_logs_to_notion import run_audit_mirror_job
        from packages.agencyu.services.system_state import SystemState, SystemKeys

        with patch("packages.agencyu.jobs.mirror_audit_logs_to_notion.NotionClient"), \
             patch("packages.agencyu.jobs.mirror_audit_logs_to_notion.NotionAPI"):
            run_audit_mirror_job(
                conn,
                correlation_id="corr_stop",
                system_audit_log_db_id="db_test",
                safe_mode=True,
            )

        state = SystemState(conn)
        buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON)
        items = buf.get("items", [])
        assert len(items) >= 1
        assert items[0]["job"] == "mirror_audit_logs_to_notion"
        assert "SAFE_MODE" in items[0]["reason"]


# ── Health endpoint response structure ──


class TestSystemHealthEndpoint:
    def _build_health_response(self, conn):
        """Build the health response using the same logic as the endpoint."""
        from packages.agencyu.services.system_state import SystemState, SystemKeys

        state = SystemState(conn)

        cooldown_until = state.get_int(SystemKeys.NOTION_AUDIT_MIRROR_COOLDOWN_UNTIL_EPOCH, default=0) or 0
        now_epoch = int(time.time())
        cooldown_active = now_epoch < cooldown_until if cooldown_until else False
        last_trip_reason = state.get_str(SystemKeys.NOTION_AUDIT_MIRROR_LAST_TRIP_REASON, default="") or ""

        try:
            q_row = conn.execute("SELECT COUNT(1) FROM scheduled_actions WHERE status='pending'").fetchone()
            queue_depth = int(q_row[0]) if q_row else 0
            queue_source = "live"
        except Exception:
            queue_depth = state.get_int(SystemKeys.QUEUE_DEPTH_SCHEDULED_ACTIONS, default=0) or 0
            queue_source = "state"

        last_reconcile_success = state.get_str(SystemKeys.LAST_RECONCILE_SUCCESS_AT)
        last_reconcile_attempt = state.get_str(SystemKeys.LAST_RECONCILE_ATTEMPT_AT)

        recent_stops = state.get_json(
            SystemKeys.RECENT_JOB_STOPS_JSON, default={"items": []}
        ).get("items", [])[:10]

        try:
            fail_rows = conn.execute(
                "SELECT ts, correlation_id, system, action, target, result, stop_reason "
                "FROM audit_logs WHERE result IN ('failed','blocked') "
                "ORDER BY ts DESC LIMIT 10"
            ).fetchall()
            recent_failures = [dict(r) for r in fail_rows]
        except Exception:
            recent_failures = []

        warnings: list[str] = []
        if cooldown_active:
            warnings.append("circuit_breaker_cooldown_active")
        if queue_depth > 500:
            warnings.append("queue_depth_over_500")

        return {
            "ok": len(warnings) == 0,
            "cooldown": {
                "active": cooldown_active,
                "until_epoch": cooldown_until,
                "last_trip_reason": last_trip_reason,
            },
            "queue": {
                "scheduled_actions_pending": queue_depth,
                "source": queue_source,
            },
            "reconcile": {
                "last_success_at": last_reconcile_success,
                "last_attempt_at": last_reconcile_attempt,
            },
            "recent_job_stop_reasons": recent_stops,
            "recent_failures": recent_failures,
            "warnings": warnings,
        }

    def test_healthy_by_default(self, conn):
        resp = self._build_health_response(conn)
        assert resp["ok"] is True
        assert resp["cooldown"]["active"] is False
        assert resp["warnings"] == []
        assert resp["queue"]["scheduled_actions_pending"] == 0

    def test_shows_cooldown_when_active(self, conn):
        from packages.agencyu.services.system_state import SystemState, SystemKeys

        state = SystemState(conn)
        future_epoch = int(time.time()) + 3600
        state.set_int(SystemKeys.NOTION_AUDIT_MIRROR_COOLDOWN_UNTIL_EPOCH, future_epoch)
        state.set_str(SystemKeys.NOTION_AUDIT_MIRROR_LAST_TRIP_REASON, "test_trip")

        resp = self._build_health_response(conn)
        assert resp["ok"] is False
        assert resp["cooldown"]["active"] is True
        assert resp["cooldown"]["until_epoch"] == future_epoch
        assert resp["cooldown"]["last_trip_reason"] == "test_trip"
        assert "circuit_breaker_cooldown_active" in resp["warnings"]

    def test_shows_reconcile_timestamps(self, conn):
        from packages.agencyu.services.system_state import SystemState, SystemKeys

        state = SystemState(conn)
        state.set_str(SystemKeys.LAST_RECONCILE_SUCCESS_AT, "2025-06-01T10:00:00Z")
        state.set_str(SystemKeys.LAST_RECONCILE_ATTEMPT_AT, "2025-06-01T10:05:00Z")

        resp = self._build_health_response(conn)
        assert resp["reconcile"]["last_success_at"] == "2025-06-01T10:00:00Z"
        assert resp["reconcile"]["last_attempt_at"] == "2025-06-01T10:05:00Z"

    def test_shows_recent_failures(self, conn):
        _insert_audit_row(conn, id_="f1", system="notion", action="write", result="failed")

        resp = self._build_health_response(conn)
        assert len(resp["recent_failures"]) == 1
        assert resp["recent_failures"][0]["result"] == "failed"

    def test_shows_recent_stop_reasons(self, conn):
        from packages.agencyu.services.system_state import SystemState, push_recent_stop

        state = SystemState(conn)
        push_recent_stop(state, {"ts": "t1", "job": "mirror", "reason": "cooldown"})

        resp = self._build_health_response(conn)
        assert len(resp["recent_job_stop_reasons"]) == 1
        assert resp["recent_job_stop_reasons"][0]["job"] == "mirror"

    def test_queue_depth_from_scheduled_actions(self, conn):
        conn.execute(
            "INSERT INTO scheduled_actions (action_type, run_at_iso, payload_json, status) VALUES ('test', '2099-01-01', '{}', 'pending')"
        )
        conn.execute(
            "INSERT INTO scheduled_actions (action_type, run_at_iso, payload_json, status) VALUES ('test2', '2099-01-01', '{}', 'pending')"
        )
        conn.commit()

        resp = self._build_health_response(conn)
        assert resp["queue"]["scheduled_actions_pending"] == 2
        assert resp["queue"]["source"] == "live"
