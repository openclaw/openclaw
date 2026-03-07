"""Tests for the Notion compliance layer: audit_writer, system_state, views_registry."""
from __future__ import annotations

import json
import sqlite3
import time

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    """In-memory SQLite with full schema."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


# ── AuditWriter tests ──


class TestAuditWriter:
    def test_write_event_to_sqlite(self, conn):
        from packages.agencyu.notion.audit_writer import AuditWriter

        writer = AuditWriter(conn)
        audit_id = writer.write_event(
            action="notion.verify",
            target_type="notion_workspace",
            target_id="root_123",
            details={"ok": True, "issues": 0},
            correlation_id="corr_abc",
            system="openclaw",
            result="ok",
        )

        assert audit_id.startswith("aud_")

        row = conn.execute(
            "SELECT * FROM system_audit_log WHERE id=?", (audit_id,)
        ).fetchone()
        assert row is not None
        assert row["action"] == "notion.verify"
        assert row["target"] == "notion_workspace:root_123"
        assert row["result"] == "ok"
        assert row["correlation_id"] == "corr_abc"
        assert "issues" in row["details"]

    def test_write_batch(self, conn):
        from packages.agencyu.notion.audit_writer import AuditWriter

        writer = AuditWriter(conn)
        events = [
            {"action": "test1", "target_type": "t", "target_id": "1"},
            {"action": "test2", "target_type": "t", "target_id": "2"},
        ]
        ids = writer.write_batch(events, correlation_id="batch_1")
        assert len(ids) == 2
        assert all(i.startswith("aud_") for i in ids)


# ── SystemState tests ──


class TestSystemState:
    def test_cooldown_inactive_by_default(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        state = SystemState(conn)
        assert state.cooldown_active() is False

    def test_write_lock_defaults_locked(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        state = SystemState(conn)
        # No write_lock key → default locked
        assert state.write_lock_active() is True

    def test_write_lock_respects_false(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        conn.execute(
            "INSERT INTO system_settings (key, value, updated_at) VALUES ('write_lock', 'false', '2026-01-01')"
        )
        conn.commit()

        state = SystemState(conn)
        assert state.write_lock_active() is False

    def test_queue_depth_zero_when_empty(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        state = SystemState(conn)
        assert state.queue_depth() == 0

    def test_queue_depth_counts_pending(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        conn.execute(
            "INSERT INTO scheduled_actions (action_type, run_at_iso, payload_json, status) VALUES ('test', '2026-01-01', '{}', 'pending')"
        )
        conn.execute(
            "INSERT INTO scheduled_actions (action_type, run_at_iso, payload_json, status) VALUES ('test', '2026-01-01', '{}', 'done')"
        )
        conn.commit()

        state = SystemState(conn)
        assert state.queue_depth() == 1

    def test_prune_recent_job_stops_noop_when_small(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        conn.execute(
            "INSERT INTO system_state (key, value) VALUES ('recent_job_stops_json', ?)",
            (json.dumps([{"ts": 1, "reason": "test"}]),),
        )
        conn.commit()

        state = SystemState(conn, max_recent_stops=200)
        result = state.prune_recent_job_stops()
        assert result["action"] == "noop"

    def test_prune_recent_job_stops_trims_excess(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        items = [{"ts": i, "reason": f"stop_{i}"} for i in range(50)]
        conn.execute(
            "INSERT INTO system_state (key, value) VALUES ('recent_job_stops_json', ?)",
            (json.dumps(items),),
        )
        conn.commit()

        state = SystemState(conn, max_recent_stops=10)
        result = state.prune_recent_job_stops()
        assert result["action"] == "pruned"
        assert result["before"] == 50
        assert result["after"] == 10

        # Verify persisted
        remaining = state.recent_job_stops()
        assert len(remaining) == 10
        assert remaining[0]["ts"] == 40  # kept last 10

    def test_dump_all_kv(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        conn.execute("INSERT INTO system_state (key, value) VALUES ('foo', 'bar')")
        conn.execute(
            "INSERT INTO system_settings (key, value, updated_at) VALUES ('version', '2.0', '2026-01-01')"
        )
        conn.commit()

        state = SystemState(conn)
        kv = state.dump_all_kv()
        assert "foo" in kv
        assert "settings.version" in kv

    def test_notion_health_summary(self, conn):
        from packages.agencyu.notion.system_state import SystemState

        state = SystemState(conn)
        summary = state.get_notion_health_summary()
        assert "cooldown_active" in summary
        assert "write_lock_active" in summary
        assert "queue_depth" in summary


# ── ViewsRegistry tests ──


class TestViewsRegistry:
    def test_ensure_contract_noop_when_exists(self, conn):
        from packages.agencyu.notion.views_registry import ViewContract, ViewsRegistry

        registry = ViewsRegistry(conn)

        # Pre-insert
        from packages.common.ids import new_id
        from packages.common.clock import utc_now_iso

        now = utc_now_iso()
        conn.execute(
            "INSERT INTO views_registry (id, database_key, view_name, required, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'ok', ?, ?)",
            (new_id("vr"), "clients", "Active Clients", now, now),
        )
        conn.commit()

        vc = ViewContract(
            view_key="clients.active_clients",
            database_key="clients",
            view_name="Active Clients",
        )
        result = registry.ensure_contract(vc, safe_mode=False)
        assert result["action"] == "noop"

    def test_ensure_contract_creates_when_missing(self, conn):
        from packages.agencyu.notion.views_registry import ViewContract, ViewsRegistry

        registry = ViewsRegistry(conn)
        vc = ViewContract(
            view_key="tasks.open_tasks",
            database_key="tasks",
            view_name="Open Tasks",
        )
        result = registry.ensure_contract(vc, safe_mode=False)
        assert result["action"] == "created"

        # Verify in SQLite
        row = conn.execute(
            "SELECT * FROM views_registry WHERE database_key='tasks' AND view_name='Open Tasks'"
        ).fetchone()
        assert row is not None

    def test_ensure_contract_simulate_mode(self, conn):
        from packages.agencyu.notion.views_registry import ViewContract, ViewsRegistry

        registry = ViewsRegistry(conn)
        vc = ViewContract(
            view_key="tasks.open_tasks",
            database_key="tasks",
            view_name="Open Tasks",
        )
        result = registry.ensure_contract(vc, safe_mode=True)
        assert result["action"] == "simulate_create"

        # Not created in SQLite
        row = conn.execute(
            "SELECT * FROM views_registry WHERE database_key='tasks' AND view_name='Open Tasks'"
        ).fetchone()
        assert row is None

    def test_get_missing_views(self, conn):
        from packages.agencyu.notion.views_registry import ViewsRegistry

        from packages.common.ids import new_id
        from packages.common.clock import utc_now_iso

        now = utc_now_iso()
        conn.execute(
            "INSERT INTO views_registry (id, database_key, view_name, required, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'missing', ?, ?)",
            (new_id("vr"), "clients", "Missing View", now, now),
        )
        conn.execute(
            "INSERT INTO views_registry (id, database_key, view_name, required, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'ok', ?, ?)",
            (new_id("vr"), "clients", "Good View", now, now),
        )
        conn.commit()

        registry = ViewsRegistry(conn)
        missing = registry.get_missing_views()
        assert len(missing) == 1
        assert missing[0]["view_name"] == "Missing View"


# ── State pruner job test ──


class TestStatePrunerJob:
    def test_run_state_pruner(self, conn):
        from packages.agencyu.jobs.state_pruner import run_state_pruner

        result = run_state_pruner(conn)
        assert result["ok"] is True


# ── Admin state endpoint test ──


class TestAdminStateEndpoint:
    def test_admin_state_endpoint(self, conn):
        """Verify SystemState can be used from admin endpoint pattern."""
        from packages.agencyu.notion.system_state import SystemState

        state = SystemState(conn)
        response = {
            "ok": True,
            "kv": state.dump_all_kv(),
            "notion_health": state.get_notion_health_summary(),
        }
        assert response["ok"] is True
        assert isinstance(response["kv"], dict)
        assert "cooldown_active" in response["notion_health"]
