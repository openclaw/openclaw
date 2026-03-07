"""Tests for Views Registry checks, ensure, mutation_guard, daily_reconcile, and health wiring."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


# ════════════════════════════════════════════
# checks.py — required_view_keys_minimum + find_missing_view_keys
# ════════════════════════════════════════════


class TestChecks:
    def test_required_view_keys_minimum_returns_list(self):
        from packages.agencyu.notion.views_registry.checks import required_view_keys_minimum

        keys = required_view_keys_minimum()
        assert isinstance(keys, list)
        assert len(keys) == 7
        assert "cc.active_combos" in keys

    def test_find_missing_no_db_id(self):
        from packages.agencyu.notion.views_registry.checks import find_missing_view_keys

        api = MagicMock()
        missing = find_missing_view_keys(api, views_registry_db_id="")
        assert len(missing) == 7  # All missing when no DB

    def test_find_missing_all_registered(self):
        from packages.agencyu.notion.views_registry.checks import find_missing_view_keys

        api = MagicMock()
        # Create rows matching all 7 view keys
        from packages.agencyu.notion.views_registry.checks import required_view_keys_minimum
        keys = required_view_keys_minimum()

        rows = []
        for key in keys:
            rows.append({
                "properties": {
                    "Notes": {"rich_text": [{"plain_text": f"Page: page_{key.replace('.', '_')}."}]},
                },
            })
        api.query_all_database_rows.return_value = rows
        # _page_title returns matching keys
        api._page_title.side_effect = keys
        api.can_read_page.return_value = True

        missing = find_missing_view_keys(api, views_registry_db_id="vr_db")
        assert missing == []

    def test_find_missing_some_missing(self):
        from packages.agencyu.notion.views_registry.checks import find_missing_view_keys

        api = MagicMock()
        # Only 2 rows registered
        rows = [
            {"properties": {"Notes": {"rich_text": [{"plain_text": "Page: p1."}]}}},
            {"properties": {"Notes": {"rich_text": [{"plain_text": "Page: p2."}]}}},
        ]
        api.query_all_database_rows.return_value = rows
        api._page_title.side_effect = ["cc.active_combos", "cc.pipeline_quality"]
        api.can_read_page.return_value = True

        missing = find_missing_view_keys(
            api,
            views_registry_db_id="vr_db",
            required_keys=["cc.active_combos", "cc.pipeline_quality", "cc.finance_snapshot"],
        )
        assert missing == ["cc.finance_snapshot"]

    def test_find_missing_page_inaccessible(self):
        from packages.agencyu.notion.views_registry.checks import find_missing_view_keys

        api = MagicMock()
        rows = [
            {"properties": {"Notes": {"rich_text": [{"plain_text": "Page: dead_page."}]}}},
        ]
        api.query_all_database_rows.return_value = rows
        api._page_title.return_value = "cc.test"
        api.can_read_page.return_value = False

        missing = find_missing_view_keys(
            api, views_registry_db_id="vr_db", required_keys=["cc.test"],
        )
        assert missing == ["cc.test"]

    def test_find_missing_no_page_id_in_notes(self):
        from packages.agencyu.notion.views_registry.checks import find_missing_view_keys

        api = MagicMock()
        rows = [
            {"properties": {"Notes": {"rich_text": [{"plain_text": "Some random note"}]}}},
        ]
        api.query_all_database_rows.return_value = rows
        api._page_title.return_value = "cc.test"

        missing = find_missing_view_keys(
            api, views_registry_db_id="vr_db", required_keys=["cc.test"],
        )
        assert missing == ["cc.test"]

    def test_find_missing_query_failure(self):
        from packages.agencyu.notion.views_registry.checks import find_missing_view_keys

        api = MagicMock()
        api.query_all_database_rows.side_effect = Exception("API error")

        missing = find_missing_view_keys(
            api, views_registry_db_id="vr_db", required_keys=["cc.test"],
        )
        assert missing == ["cc.test"]


# ════════════════════════════════════════════
# MutationGuardDecision + SystemState.mutation_guard
# ════════════════════════════════════════════


class TestMutationGuard:
    def _make_state(self, write_lock="false", backoff_until=""):
        from packages.agencyu.notion.system_state import SystemState
        from packages.common.db import connect, init_schema
        from packages.common.clock import utc_now_iso

        conn = connect(":memory:")
        init_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("write_lock", write_lock, utc_now_iso()),
        )
        if backoff_until:
            conn.execute(
                "INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)",
                ("system_backoff_until", backoff_until),
            )
        conn.commit()
        return SystemState(conn), conn

    def test_mutations_allowed_when_unlocked(self):
        state, _ = self._make_state(write_lock="false")
        guard = state.mutation_guard(request_mutations=True, default_safe_mode=False)

        assert guard.allow_mutations is True
        assert guard.safe_mode is False
        assert guard.reason == "mutations_allowed"
        assert guard.write_lock is False
        assert guard.cooldown_active is False

    def test_mutations_blocked_by_write_lock(self):
        state, _ = self._make_state(write_lock="true")
        guard = state.mutation_guard(request_mutations=True, default_safe_mode=False)

        assert guard.allow_mutations is False
        assert guard.safe_mode is True
        assert "write_lock_active" in guard.reason

    def test_mutations_blocked_by_cooldown(self):
        state, _ = self._make_state(write_lock="false", backoff_until="2099-01-01T00:00:00Z")
        guard = state.mutation_guard(request_mutations=True, default_safe_mode=False)

        assert guard.allow_mutations is False
        assert guard.safe_mode is True
        assert "cooldown_active" in guard.reason

    def test_mutations_not_requested(self):
        state, _ = self._make_state(write_lock="false")
        guard = state.mutation_guard(request_mutations=False)

        assert guard.allow_mutations is False
        assert guard.safe_mode is True
        assert "mutations_not_requested" in guard.reason

    def test_mutations_blocked_by_both(self):
        state, _ = self._make_state(write_lock="true", backoff_until="2099-01-01T00:00:00Z")
        guard = state.mutation_guard(request_mutations=True)

        assert guard.allow_mutations is False
        assert "write_lock_active" in guard.reason
        assert "cooldown_active" in guard.reason

    def test_record_reconcile_success(self):
        state, conn = self._make_state()
        state.record_reconcile_success("views_registry")

        ts = state.last_reconcile_ts("views_registry")
        assert ts is not None
        assert "T" in ts  # ISO format


# ════════════════════════════════════════════
# ViewsRegistryEnsurer
# ════════════════════════════════════════════


class TestViewsRegistryEnsurer:
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_registry_db_id")
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_parent_page_id")
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_db_key_map")
    @patch("packages.agencyu.notion.views_registry.ensure.find_missing_view_keys")
    def test_already_compliant(self, mock_missing, mock_map, mock_parent, mock_db):
        from packages.agencyu.notion.views_registry.ensure import ViewsRegistryEnsurer

        mock_db.return_value = "vr_db_id"
        mock_parent.return_value = "parent_page_id"
        mock_map.return_value = {"outcomes": "db_outcomes"}
        mock_missing.return_value = []

        api = MagicMock()
        ensurer = ViewsRegistryEnsurer(api)
        result = ensurer.ensure_cc_compliant(allow_mutations=True, reason="test")

        assert result["ok"] is True
        assert result["status"] == "already_compliant"
        assert result["mutated"] is False

    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_registry_db_id")
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_parent_page_id")
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_db_key_map")
    @patch("packages.agencyu.notion.views_registry.ensure.find_missing_view_keys")
    def test_not_compliant_no_mutation(self, mock_missing, mock_map, mock_parent, mock_db):
        from packages.agencyu.notion.views_registry.ensure import ViewsRegistryEnsurer

        mock_db.return_value = "vr_db_id"
        mock_parent.return_value = "parent_page_id"
        mock_map.return_value = {}
        mock_missing.return_value = ["cc.active_combos"]

        api = MagicMock()
        ensurer = ViewsRegistryEnsurer(api)
        result = ensurer.ensure_cc_compliant(allow_mutations=False, reason="test")

        assert result["status"] == "not_compliant_no_mutation"
        assert result["missing_view_keys"] == ["cc.active_combos"]
        assert result["mutated"] is False

    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_registry_db_id")
    def test_db_not_found(self, mock_db):
        from packages.agencyu.notion.views_registry.ensure import ViewsRegistryEnsurer

        mock_db.return_value = None
        api = MagicMock()
        ensurer = ViewsRegistryEnsurer(api)
        result = ensurer.ensure_cc_compliant(allow_mutations=True, reason="test")

        assert result["ok"] is False
        assert result["status"] == "views_registry_db_not_found"

    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_registry_db_id")
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_parent_page_id")
    def test_parent_page_not_configured(self, mock_parent, mock_db):
        from packages.agencyu.notion.views_registry.ensure import ViewsRegistryEnsurer

        mock_db.return_value = "vr_db_id"
        mock_parent.return_value = None
        api = MagicMock()
        ensurer = ViewsRegistryEnsurer(api)
        result = ensurer.ensure_cc_compliant(allow_mutations=True, reason="test")

        assert result["ok"] is False
        assert result["status"] == "views_parent_page_not_configured"

    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_registry_db_id")
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_views_parent_page_id")
    @patch("packages.agencyu.notion.views_registry.ensure.resolve_db_key_map")
    @patch("packages.agencyu.notion.views_registry.ensure.find_missing_view_keys")
    def test_simulated_mode(self, mock_missing, mock_map, mock_parent, mock_db):
        from packages.agencyu.notion.views_registry.ensure import ViewsRegistryEnsurer

        mock_db.return_value = "vr_db_id"
        mock_parent.return_value = "parent_page_id"
        mock_map.return_value = {"outcomes": "db_outcomes"}
        mock_missing.return_value = ["cc.active_combos"]

        api = MagicMock()
        api.query_all_database_rows.return_value = []
        ensurer = ViewsRegistryEnsurer(api)
        result = ensurer.ensure_cc_compliant(
            allow_mutations=True, safe_mode=True, reason="test",
        )

        assert result["status"] == "simulated"
        assert result["mutated"] is False
        assert "heal1" in result
        assert "seed" in result
        assert "heal2" in result


# ════════════════════════════════════════════
# daily_reconcile
# ════════════════════════════════════════════


class TestDailyReconcile:
    def _make_conn(self, write_lock="false"):
        from packages.common.db import connect, init_schema
        from packages.common.clock import utc_now_iso

        conn = connect(":memory:")
        init_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("write_lock", write_lock, utc_now_iso()),
        )
        conn.commit()
        return conn

    @patch("packages.domain.daily_reconcile.ViewsRegistryEnsurer")
    def test_runs_with_mutations_allowed(self, mock_ensurer_cls):
        from packages.domain.daily_reconcile import run_daily_reconcile

        mock_ensurer = MagicMock()
        mock_ensurer.ensure_cc_compliant.return_value = {
            "ok": True, "status": "already_compliant",
            "missing_view_keys": [], "mutated": False,
        }
        mock_ensurer_cls.return_value = mock_ensurer

        conn = self._make_conn(write_lock="false")
        api = MagicMock()

        result = run_daily_reconcile(conn, api)

        assert result["ok"] is True
        assert result["guard"]["allow_mutations"] is True
        assert result["guard"]["safe_mode"] is False

        # Verify ensurer was called with apply mode
        call_kwargs = mock_ensurer.ensure_cc_compliant.call_args[1]
        assert call_kwargs["allow_mutations"] is True
        assert call_kwargs["safe_mode"] is False

    @patch("packages.domain.daily_reconcile.ViewsRegistryEnsurer")
    def test_blocked_by_write_lock(self, mock_ensurer_cls):
        from packages.domain.daily_reconcile import run_daily_reconcile

        mock_ensurer = MagicMock()
        mock_ensurer.ensure_cc_compliant.return_value = {
            "ok": True, "status": "not_compliant_no_mutation",
            "missing_view_keys": ["cc.test"], "mutated": False,
        }
        mock_ensurer_cls.return_value = mock_ensurer

        conn = self._make_conn(write_lock="true")
        api = MagicMock()

        result = run_daily_reconcile(conn, api)

        assert result["guard"]["allow_mutations"] is False
        assert result["guard"]["write_lock"] is True

    @patch("packages.domain.daily_reconcile.ViewsRegistryEnsurer")
    def test_records_reconcile_success(self, mock_ensurer_cls):
        from packages.domain.daily_reconcile import run_daily_reconcile
        from packages.agencyu.notion.system_state import SystemState

        mock_ensurer = MagicMock()
        mock_ensurer.ensure_cc_compliant.return_value = {"ok": True, "status": "repaired"}
        mock_ensurer_cls.return_value = mock_ensurer

        conn = self._make_conn()
        api = MagicMock()

        run_daily_reconcile(conn, api)

        state = SystemState(conn)
        ts = state.last_reconcile_ts("views_registry")
        assert ts is not None


# ════════════════════════════════════════════
# Admin health endpoint — views_registry section
# ════════════════════════════════════════════


class TestHealthEndpointViewsRegistry:
    def test_health_endpoint_has_self_heal_param(self):
        """Verify the health endpoint accepts self_heal query parameter."""
        from services.webhook_gateway.routes.admin_health import admin_system_health
        import inspect

        sig = inspect.signature(admin_system_health)
        assert "self_heal" in sig.parameters

    def test_daily_reconcile_endpoint_exists(self):
        """Verify the daily_reconcile endpoint is registered."""
        from services.webhook_gateway.routes.admin_system import router

        paths = [r.path for r in router.routes]
        assert "/daily_reconcile" in paths


# ════════════════════════════════════════════
# ensure.py helpers
# ════════════════════════════════════════════


class TestEnsureHelpers:
    def test_resolve_views_registry_db_id_found(self):
        from packages.agencyu.notion.views_registry.ensure import resolve_views_registry_db_id

        api = MagicMock()
        api.find_database_under_root.return_value = "found_id"
        assert resolve_views_registry_db_id(api) == "found_id"

    def test_resolve_views_registry_db_id_not_found(self):
        from packages.agencyu.notion.views_registry.ensure import resolve_views_registry_db_id

        api = MagicMock()
        api.find_database_under_root.side_effect = Exception("not found")
        assert resolve_views_registry_db_id(api) is None

    def test_resolve_views_parent_page_id(self):
        from packages.agencyu.notion.views_registry.ensure import resolve_views_parent_page_id

        with patch("packages.agencyu.notion.views_registry.ensure.settings") as mock_settings:
            mock_settings.NOTION_PAGE_DB_ROOT_ID = "page_123"
            assert resolve_views_parent_page_id() == "page_123"

    def test_resolve_views_parent_page_id_empty(self):
        from packages.agencyu.notion.views_registry.ensure import resolve_views_parent_page_id

        with patch("packages.agencyu.notion.views_registry.ensure.settings") as mock_settings:
            mock_settings.NOTION_PAGE_DB_ROOT_ID = ""
            assert resolve_views_parent_page_id() is None
