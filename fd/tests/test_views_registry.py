"""Tests for Views Registry spec, seeder, healer, and admin endpoints."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


# ════════════════════════════════════════════
# ViewSpec + minimum_view_specs
# ════════════════════════════════════════════


class TestViewSpec:
    def test_frozen_dataclass(self):
        from packages.agencyu.notion.views_registry.spec import ViewSpec

        spec = ViewSpec(
            view_key="cc.test",
            db_key="tests",
            page_title="View: Test",
            view_type="table",
            purpose="Testing",
        )
        assert spec.view_key == "cc.test"
        with pytest.raises(AttributeError):
            spec.view_key = "changed"  # type: ignore[misc]

    def test_minimum_view_specs_count(self):
        from packages.agencyu.notion.views_registry.spec import minimum_view_specs

        specs = minimum_view_specs()
        assert len(specs) == 7

    def test_minimum_view_specs_keys(self):
        from packages.agencyu.notion.views_registry.spec import minimum_view_specs

        specs = minimum_view_specs()
        keys = {s.view_key for s in specs}
        expected = {
            "cc.active_combos",
            "cc.pipeline_quality",
            "cc.finance_snapshot",
            "cc.fulfillment_watchlist",
            "audit.recent",
            "tasks.today",
            "meetings.showed_7d",
        }
        assert keys == expected

    def test_minimum_view_specs_unique_keys(self):
        from packages.agencyu.notion.views_registry.spec import minimum_view_specs

        specs = minimum_view_specs()
        keys = [s.view_key for s in specs]
        assert len(keys) == len(set(keys))

    def test_all_specs_have_required_fields(self):
        from packages.agencyu.notion.views_registry.spec import minimum_view_specs

        for spec in minimum_view_specs():
            assert spec.view_key, "view_key must not be empty"
            assert spec.db_key, "db_key must not be empty"
            assert spec.page_title, "page_title must not be empty"
            assert spec.view_type, "view_type must not be empty"
            assert spec.purpose, "purpose must not be empty"


# ════════════════════════════════════════════
# ViewsRegistrySeeder
# ════════════════════════════════════════════


class TestViewsRegistrySeeder:
    def _make_seeder(self):
        from packages.agencyu.notion.views_registry.seeder import ViewsRegistrySeeder

        api = MagicMock()
        api.query_all_database_rows.return_value = []
        api.create_page.return_value = "new_page_id"
        return ViewsRegistrySeeder(api), api

    def _make_spec(self, view_key="cc.test", db_key="tests"):
        from packages.agencyu.notion.views_registry.spec import ViewSpec

        return ViewSpec(
            view_key=view_key,
            db_key=db_key,
            page_title=f"View: {view_key}",
            view_type="table",
            purpose="Test purpose",
        )

    def test_seed_safe_mode_simulates(self):
        seeder, api = self._make_seeder()
        spec = self._make_spec()

        result = seeder.seed_minimum(
            views_registry_db_id="vr_db_123",
            views_parent_page_id="parent_456",
            db_key_to_database_id={"tests": "db_tests_id"},
            specs=[spec],
            safe_mode=True,
        )

        assert result["ok"] is True
        assert result["safe_mode"] is True
        assert result["simulated"] == 1
        assert result["seeded"] == 0
        assert result["results"][0]["status"] == "simulated"
        api.create_page.assert_not_called()

    def test_seed_apply_creates_page_and_row(self):
        seeder, api = self._make_seeder()
        spec = self._make_spec()

        result = seeder.seed_minimum(
            views_registry_db_id="vr_db_123",
            views_parent_page_id="parent_456",
            db_key_to_database_id={"tests": "db_tests_id"},
            specs=[spec],
            safe_mode=False,
            correlation_id="test_corr",
        )

        assert result["ok"] is True
        assert result["seeded"] == 1
        assert result["results"][0]["status"] == "seeded"
        assert result["results"][0]["page_id"] == "new_page_id"
        api.create_page.assert_called_once()
        api.append_block_children.assert_called_once()
        api.upsert_views_registry_row.assert_called_once()

    def test_seed_skips_already_registered(self):
        seeder, api = self._make_seeder()
        spec = self._make_spec()

        # Simulate existing row
        api.query_all_database_rows.return_value = [{
            "id": "existing_row",
            "properties": {
                "title": {"title": [{"plain_text": "cc.test"}]},
            },
        }]
        api._page_title.return_value = "cc.test"

        result = seeder.seed_minimum(
            views_registry_db_id="vr_db_123",
            views_parent_page_id="parent_456",
            db_key_to_database_id={"tests": "db_tests_id"},
            specs=[spec],
            safe_mode=False,
        )

        assert result["skipped"] == 1
        assert result["results"][0]["status"] == "already_registered"
        api.create_page.assert_not_called()

    def test_seed_blocked_missing_database(self):
        seeder, api = self._make_seeder()
        spec = self._make_spec(db_key="nonexistent")

        result = seeder.seed_minimum(
            views_registry_db_id="vr_db_123",
            views_parent_page_id="parent_456",
            db_key_to_database_id={},  # No databases mapped
            specs=[spec],
            safe_mode=False,
        )

        assert result["skipped"] == 1
        assert result["results"][0]["status"] == "blocked_missing_database"

    def test_seed_multiple_specs(self):
        seeder, api = self._make_seeder()
        specs = [
            self._make_spec("cc.a", "db_a"),
            self._make_spec("cc.b", "db_b"),
            self._make_spec("cc.c", "db_c"),
        ]

        result = seeder.seed_minimum(
            views_registry_db_id="vr_db_123",
            views_parent_page_id="parent_456",
            db_key_to_database_id={"db_a": "id_a", "db_b": "id_b"},  # db_c missing
            specs=specs,
            safe_mode=True,
        )

        assert result["total"] == 3
        assert result["simulated"] == 2  # db_a and db_b
        assert result["skipped"] == 1  # db_c blocked


# ════════════════════════════════════════════
# ViewsRegistryHealer
# ════════════════════════════════════════════


class TestViewsRegistryHealer:
    def _make_healer(self):
        from packages.agencyu.notion.views_registry.healer import ViewsRegistryHealer

        api = MagicMock()
        api.query_all_database_rows.return_value = []
        api.can_read_page.return_value = True
        api._page_title.return_value = ""
        api._select_value.return_value = None
        return ViewsRegistryHealer(api), api

    def _make_spec(self, view_key="cc.test", db_key="tests"):
        from packages.agencyu.notion.views_registry.spec import ViewSpec

        return ViewSpec(
            view_key=view_key,
            db_key=db_key,
            page_title=f"View: {view_key}",
            view_type="table",
            purpose="Test purpose",
        )

    def test_heal_missing_row_safe_mode(self):
        healer, api = self._make_healer()
        spec = self._make_spec()

        result = healer.heal(
            views_registry_db_id="vr_db",
            views_parent_page_id="parent",
            db_key_to_database_id={"tests": "db_id"},
            specs=[spec],
            safe_mode=True,
        )

        assert result["ok"] is True
        assert result["simulated"] == 1
        assert result["results"][0]["status"] == "missing_row_simulated"

    def test_heal_missing_row_apply(self):
        healer, api = self._make_healer()
        api.create_page.return_value = "new_page"
        spec = self._make_spec()

        result = healer.heal(
            views_registry_db_id="vr_db",
            views_parent_page_id="parent",
            db_key_to_database_id={"tests": "db_id"},
            specs=[spec],
            safe_mode=False,
        )

        assert result["repaired"] == 1
        assert result["results"][0]["status"] == "seeded"

    def test_heal_ok_row(self):
        healer, api = self._make_healer()
        spec = self._make_spec()

        # Row exists, page accessible, db_key matches
        api.query_all_database_rows.return_value = [{
            "id": "row_1",
            "properties": {
                "Notes": {"rich_text": [{"plain_text": "Page: page_abc."}]},
                "Database Key": {"type": "select", "select": {"name": "tests"}},
            },
        }]
        api._page_title.return_value = "cc.test"
        api._select_value.return_value = "tests"
        api.can_read_page.return_value = True

        result = healer.heal(
            views_registry_db_id="vr_db",
            views_parent_page_id="parent",
            db_key_to_database_id={"tests": "db_id"},
            specs=[spec],
            safe_mode=False,
        )

        assert result["ok_count"] == 1
        assert result["results"][0]["status"] == "ok"
        api.update_page.assert_called_once()

    def test_heal_drift_page_missing_safe_mode(self):
        healer, api = self._make_healer()
        spec = self._make_spec()

        api.query_all_database_rows.return_value = [{
            "id": "row_1",
            "properties": {
                "Notes": {"rich_text": [{"plain_text": "Page: page_abc."}]},
            },
        }]
        api._page_title.return_value = "cc.test"
        api._select_value.return_value = None
        api.can_read_page.return_value = False

        result = healer.heal(
            views_registry_db_id="vr_db",
            views_parent_page_id="parent",
            db_key_to_database_id={"tests": "db_id"},
            specs=[spec],
            safe_mode=True,
        )

        assert result["simulated"] == 1
        assert result["results"][0]["status"] == "drift_detected_simulated"
        assert "page_missing" in result["results"][0]["issues"]

    def test_heal_drift_db_key_mismatch(self):
        healer, api = self._make_healer()
        spec = self._make_spec()

        api.query_all_database_rows.return_value = [{
            "id": "row_1",
            "properties": {
                "Notes": {"rich_text": [{"plain_text": "Page: page_abc."}]},
                "Database Key": {"type": "select", "select": {"name": "wrong_key"}},
            },
        }]
        api._page_title.return_value = "cc.test"
        api._select_value.return_value = "wrong_key"
        api.can_read_page.return_value = True

        result = healer.heal(
            views_registry_db_id="vr_db",
            views_parent_page_id="parent",
            db_key_to_database_id={"tests": "db_id"},
            specs=[spec],
            safe_mode=True,
        )

        assert result["results"][0]["status"] == "drift_detected_simulated"
        assert any("db_key_mismatch" in i for i in result["results"][0]["issues"])

    def test_status_read_only(self):
        healer, api = self._make_healer()
        spec = self._make_spec()

        # No rows
        result = healer.status(
            views_registry_db_id="vr_db",
            specs=[spec],
        )

        assert result["ok"] is True
        assert result["total"] == 1
        assert result["registered"] == 0
        assert result["results"][0]["registered"] is False

    def test_status_with_registered_row(self):
        healer, api = self._make_healer()
        spec = self._make_spec()

        api.query_all_database_rows.return_value = [{
            "id": "row_1",
            "properties": {
                "Notes": {"rich_text": [{"plain_text": "Page: page_xyz."}]},
            },
        }]
        api._page_title.return_value = "cc.test"
        api.can_read_page.return_value = True

        result = healer.status(
            views_registry_db_id="vr_db",
            specs=[spec],
        )

        assert result["registered"] == 1
        assert result["accessible"] == 1
        assert result["results"][0]["page_id"] == "page_xyz"


# ════════════════════════════════════════════
# Healer internal methods
# ════════════════════════════════════════════


class TestHealerInternals:
    def _make_healer(self):
        from packages.agencyu.notion.views_registry.healer import ViewsRegistryHealer

        api = MagicMock()
        return ViewsRegistryHealer(api), api

    def test_extract_page_id_from_notes(self):
        healer, _ = self._make_healer()

        row = {
            "properties": {
                "Notes": {
                    "rich_text": [{
                        "plain_text": "Auto-seeded by OpenClaw. Purpose: Testing. Page: abc-123-def. Correlation: test.",
                    }],
                },
            },
        }
        page_id = healer._extract_page_id_from_row(row)
        assert page_id == "abc-123-def"

    def test_extract_page_id_no_notes(self):
        healer, _ = self._make_healer()

        row = {"properties": {"Notes": {"rich_text": []}}}
        assert healer._extract_page_id_from_row(row) is None

    def test_extract_db_key(self):
        healer, api = self._make_healer()
        api._select_value.return_value = "tasks"

        row = {"properties": {}}
        assert healer._extract_db_key(row) == "tasks"

    def test_find_row_by_view_key(self):
        healer, api = self._make_healer()

        rows = [
            {"id": "r1", "properties": {}},
            {"id": "r2", "properties": {}},
        ]
        api._page_title.side_effect = ["cc.other", "cc.test"]

        found = healer._find_row_by_view_key(rows, "cc.test")
        assert found["id"] == "r2"

    def test_find_row_by_view_key_not_found(self):
        healer, api = self._make_healer()
        api._page_title.return_value = "cc.other"

        found = healer._find_row_by_view_key([{"id": "r1"}], "cc.test")
        assert found is None

    def test_load_all_rows_handles_error(self):
        healer, api = self._make_healer()
        api.query_all_database_rows.side_effect = Exception("API error")

        rows = healer._load_all_rows("vr_db")
        assert rows == []


# ════════════════════════════════════════════
# Admin routes (import check)
# ════════════════════════════════════════════


class TestViewsRegistryRoutes:
    def test_router_has_expected_routes(self):
        from services.webhook_gateway.routes.views_registry import router

        paths = [r.path for r in router.routes]
        assert "/admin/notion/views_registry/seed_minimum" in paths
        assert "/admin/notion/views_registry/heal" in paths
        assert "/admin/notion/views_registry/status" in paths

    def test_router_registered_in_main(self):
        """Verify the views_registry router is included in the main app."""
        from services.webhook_gateway.main import app

        paths = set()
        for route in app.routes:
            if hasattr(route, "path"):
                paths.add(route.path)
        assert "/admin/notion/views_registry/seed_minimum" in paths
        assert "/admin/notion/views_registry/heal" in paths
        assert "/admin/notion/views_registry/status" in paths

    def test_resolve_db_key_map_helper(self):
        """Test _resolve_db_key_map iterates manifest databases correctly."""
        from services.webhook_gateway.routes.views_registry import _resolve_db_key_map

        api = MagicMock()
        api.find_database_under_root.return_value = "found_db_id"

        with patch("packages.agencyu.notion.template_manifest.load_manifest") as mock_manifest:
            mock_m = MagicMock()
            mock_m.databases = {
                "tasks": {"title": "Tasks", "required": True},
                "outcomes": {"title": "Outcomes", "required": True},
            }
            mock_manifest.return_value = mock_m

            result = _resolve_db_key_map(api)
            assert "tasks" in result
            assert "outcomes" in result
            assert result["tasks"] == "found_db_id"
