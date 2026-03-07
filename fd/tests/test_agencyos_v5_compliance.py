"""Tests for AgencyOS v5: manifest validator, drift healer,
replay buffer, capacity, revenue forecast, and health integration."""

from __future__ import annotations

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


# ── New table existence tests ──


class TestV5Tables:
    def test_system_snapshots_table(self, conn):
        conn.execute(
            "INSERT INTO system_snapshots (key, value_json, snapshot_type, created_at) "
            "VALUES ('test', '{}', 'test_type', '2025-01-01T00:00:00Z')"
        )
        row = conn.execute("SELECT * FROM system_snapshots WHERE key='test'").fetchone()
        assert row["snapshot_type"] == "test_type"

    def test_event_replay_buffer_table(self, conn):
        conn.execute(
            "INSERT INTO event_replay_buffer (id, source, event_type, payload_json, correlation_id, received_at) "
            "VALUES ('evt1', 'ghl', 'lead.captured', '{}', 'corr1', '2025-01-01T00:00:00Z')"
        )
        row = conn.execute("SELECT * FROM event_replay_buffer WHERE id='evt1'").fetchone()
        assert row["source"] == "ghl"
        assert row["replayed"] == 0

    def test_team_capacity_v2_table(self, conn):
        conn.execute(
            "INSERT INTO team_capacity_v2 (team_member_id, display_name, role, max_concurrent_work, current_open_work, enabled, updated_at) "
            "VALUES ('tm1', 'Alice', 'designer', 5, 2, 1, '2025-01-01T00:00:00Z')"
        )
        row = conn.execute("SELECT * FROM team_capacity_v2 WHERE team_member_id='tm1'").fetchone()
        assert row["display_name"] == "Alice"
        assert row["max_concurrent_work"] == 5

    def test_revenue_forecast_table(self, conn):
        conn.execute(
            "INSERT INTO revenue_forecast (id, forecast_month, active_mrr, pipeline_value, booked_calls, "
            "historical_close_rate, projected_new_revenue, total_forecast, created_at, updated_at) "
            "VALUES ('rf1', '2025-03', 5000, 10000, 3, 0.25, 2500, 7500, '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM revenue_forecast WHERE id='rf1'").fetchone()
        assert row["forecast_month"] == "2025-03"
        assert row["total_forecast"] == 7500

    def test_revenue_forecast_unique_month(self, conn):
        conn.execute(
            "INSERT INTO revenue_forecast (id, forecast_month, active_mrr, pipeline_value, booked_calls, "
            "historical_close_rate, projected_new_revenue, total_forecast, created_at, updated_at) "
            "VALUES ('rf1', '2025-03', 5000, 0, 0, 0.0, 0, 5000, '2025-01-01', '2025-01-01')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO revenue_forecast (id, forecast_month, active_mrr, pipeline_value, booked_calls, "
                "historical_close_rate, projected_new_revenue, total_forecast, created_at, updated_at) "
                "VALUES ('rf2', '2025-03', 6000, 0, 0, 0.0, 0, 6000, '2025-01-01', '2025-01-01')"
            )


# ── Manifest Validator tests ──


class TestManifestValidator:
    def test_fully_compliant(self, conn):
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        validator = NotionManifestValidator(conn)
        # Bind all databases
        for db_key in validator.manifest.get("databases", {}).keys():
            conn.execute(
                "INSERT INTO notion_bindings (id, binding_type, notion_object_id, created_at, updated_at) "
                "VALUES (?, ?, ?, '2025-01-01', '2025-01-01')",
                (f"nb_{db_key}", db_key, f"notion_db_{db_key}"),
            )
        conn.commit()

        # Pre-build schemas that match the manifest exactly
        schemas = {}
        manifest = validator.manifest
        for db_key, db_spec in manifest["databases"].items():
            props = {}
            for prop_name, prop_spec in db_spec["properties"].items():
                p = {"type": prop_spec["type"]}
                if "options" in prop_spec:
                    p["options"] = prop_spec["options"]
                props[prop_name] = p
            schemas[db_key] = {
                "properties": props,
                "views": db_spec.get("required_views", []),
            }

        result = validator.validate(schemas=schemas)
        assert result.compliant is True
        assert len(result.issues) == 0
        assert result.manifest_version == "2.1"

    def test_missing_property(self, conn):
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        validator = NotionManifestValidator(conn)
        # Only provide clients schema with missing properties
        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    # missing ghl_contact_id, trello_board_id, etc.
                },
                "views": ["Active Clients", "By Service Package", "MRR Overview"],
            },
        }

        result = validator.validate(schemas=schemas)
        assert result.compliant is False
        missing = [i for i in result.issues if i.issue_type == "missing_property" and i.database == "clients"]
        assert len(missing) > 0
        # Missing properties should be healable
        assert all(i.healable for i in missing)

    def test_wrong_type_not_healable(self, conn):
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        validator = NotionManifestValidator(conn)
        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    "ghl_contact_id": {"type": "number"},  # should be rich_text
                    "trello_board_id": {"type": "rich_text"},
                    "service_package": {"type": "select", "options": ["Retainer", "Rollout", "CutMV", "Custom"]},
                    "status": {"type": "select", "options": ["Lead", "Active", "Paused", "Completed"]},
                    "notion_client_page_id": {"type": "rich_text"},
                    "dropbox_master_folder_url": {"type": "url"},
                    "mrr": {"type": "number"},
                    "start_date": {"type": "date"},
                },
                "views": ["Active Clients", "By Service Package", "MRR Overview"],
            },
        }

        result = validator.validate(schemas=schemas)
        wrong_type = [i for i in result.issues if i.issue_type == "wrong_type" and i.database == "clients"]
        assert len(wrong_type) == 1
        assert wrong_type[0].property_name == "ghl_contact_id"
        assert wrong_type[0].healable is False

    def test_missing_select_option_healable(self, conn):
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        validator = NotionManifestValidator(conn)
        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    "ghl_contact_id": {"type": "rich_text"},
                    "trello_board_id": {"type": "rich_text"},
                    "service_package": {"type": "select", "options": ["Retainer", "Rollout"]},  # missing CutMV, Custom
                    "status": {"type": "select", "options": ["Lead", "Active", "Paused", "Completed"]},
                    "notion_client_page_id": {"type": "rich_text"},
                    "dropbox_master_folder_url": {"type": "url"},
                    "mrr": {"type": "number"},
                    "start_date": {"type": "date"},
                },
                "views": ["Active Clients", "By Service Package", "MRR Overview"],
            },
        }

        result = validator.validate(schemas=schemas)
        missing_opts = [i for i in result.issues if i.issue_type == "missing_option" and i.database == "clients"]
        assert len(missing_opts) == 2  # CutMV and Custom
        assert all(i.healable for i in missing_opts)

    def test_missing_view_not_healable(self, conn):
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        validator = NotionManifestValidator(conn)
        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    "ghl_contact_id": {"type": "rich_text"},
                    "trello_board_id": {"type": "rich_text"},
                    "service_package": {"type": "select", "options": ["Retainer", "Rollout", "CutMV", "Custom"]},
                    "status": {"type": "select", "options": ["Lead", "Active", "Paused", "Completed"]},
                    "notion_client_page_id": {"type": "rich_text"},
                    "dropbox_master_folder_url": {"type": "url"},
                    "mrr": {"type": "number"},
                    "start_date": {"type": "date"},
                },
                "views": ["Active Clients"],  # missing 2 views
            },
        }

        result = validator.validate(schemas=schemas)
        missing_views = [i for i in result.issues if i.issue_type == "missing_view"]
        assert len(missing_views) >= 2
        assert all(not i.healable for i in missing_views)

    def test_missing_database_not_bound(self, conn):
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        validator = NotionManifestValidator(conn)
        # No bindings, no schemas — all DBs should be missing
        schemas = {}
        result = validator.validate(schemas=schemas)
        missing_dbs = [i for i in result.issues if i.issue_type == "missing_database"]
        assert len(missing_dbs) == 19  # all required databases in manifest v2.0

    def test_healable_and_manual_counts(self, conn):
        from packages.agencyu.notion.manifest_validator import NotionManifestValidator

        validator = NotionManifestValidator(conn)
        schemas = {
            "clients": {
                "properties": {
                    "name": {"type": "title"},
                    "ghl_contact_id": {"type": "number"},  # wrong type → manual
                    # missing others → healable
                },
                "views": [],  # missing views → manual
            },
        }
        result = validator.validate(schemas=schemas)
        assert result.healable_count > 0
        assert result.manual_count > 0
        assert result.healable_count + result.manual_count == len(result.issues)


# ── Drift Healer tests ──


class TestDriftHealer:
    def test_dry_run_heal(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer
        from packages.agencyu.notion.manifest_validator import DriftIssue

        notion = MagicMock()
        healer = DriftHealer(conn, notion)

        issues = [
            DriftIssue("clients", "missing_property", "email", "Property 'email' missing (type: rich_text)", healable=True),
            DriftIssue("clients", "wrong_type", "mrr", "Expected 'number', got 'text'", healable=False),
        ]

        with patch("packages.agencyu.notion.drift_healer.settings") as mock_settings:
            mock_settings.NOTION_WRITE_ENABLED = False
            mock_settings.DRY_RUN = True
            mock_settings.KILL_SWITCH = False

            result = healer.heal(issues=issues)

        assert result.dry_run is True
        assert result.healed_count == 0
        assert len(result.actions) == 2

    def test_heal_result_structure(self, conn):
        from packages.agencyu.notion.drift_healer import HealAction, HealResult

        result = HealResult(dry_run=True)
        result.actions.append(HealAction("clients", "add_property", "email", "test", success=True))
        assert result.actions[0].success is True
        assert result.actions[0].database == "clients"

    def test_action_for_issue(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer
        from packages.agencyu.notion.manifest_validator import DriftIssue

        notion = MagicMock()
        healer = DriftHealer(conn, notion)

        assert healer._action_for_issue(DriftIssue("db", "missing_property", "p", "")) == "add_property"
        assert healer._action_for_issue(DriftIssue("db", "missing_option", "p", "")) == "add_option"
        assert healer._action_for_issue(DriftIssue("db", "wrong_type", "p", "")) == "skip"

    def test_extract_type_from_details(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        notion = MagicMock()
        healer = DriftHealer(conn, notion)

        assert healer._extract_type_from_details("Property 'foo' missing (type: select)") == "select"
        assert healer._extract_type_from_details("Property 'bar' missing (type: rich_text)") == "rich_text"
        assert healer._extract_type_from_details("no type info") == "rich_text"  # default

    def test_build_property_config(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        notion = MagicMock()
        healer = DriftHealer(conn, notion)

        assert healer._build_property_config("title") == {"title": {}}
        assert healer._build_property_config("select") == {"select": {"options": []}}
        assert healer._build_property_config("checkbox") == {"checkbox": {}}
        assert healer._build_property_config("unknown_type") is None

    def test_can_write_checks(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer

        notion = MagicMock()
        healer = DriftHealer(conn, notion)

        with patch("packages.agencyu.notion.drift_healer.settings") as mock_settings:
            mock_settings.NOTION_WRITE_ENABLED = True
            mock_settings.DRY_RUN = False
            mock_settings.KILL_SWITCH = False
            mock_settings.NOTION_WRITE_LOCK = False
            assert healer._can_write() is True

            mock_settings.NOTION_WRITE_LOCK = True
            assert healer._can_write() is False

            mock_settings.NOTION_WRITE_LOCK = False
            mock_settings.KILL_SWITCH = True
            assert healer._can_write() is False

    def test_record_heal_snapshot(self, conn):
        from packages.agencyu.notion.drift_healer import DriftHealer, HealResult

        notion = MagicMock()
        healer = DriftHealer(conn, notion)

        result = HealResult(dry_run=False, healed_count=2, skipped_count=1, error_count=0)
        healer._record_heal_snapshot(result)

        row = conn.execute(
            "SELECT * FROM system_snapshots WHERE key='last_drift_heal'"
        ).fetchone()
        assert row is not None
        assert row["snapshot_type"] == "drift_heal"
        data = json.loads(row["value_json"])
        assert data["healed"] == 2


# ── Replay Buffer tests ──


class TestReplayBuffer:
    def test_store_and_retrieve(self, conn):
        from packages.agencyu.sync.replay_buffer import get_replayable_events, store_event

        eid = store_event(conn, source="ghl", event_type="lead.captured", payload={"foo": 1}, correlation_id="c1")
        assert eid.startswith("evt_")

        events = get_replayable_events(conn)
        assert len(events) == 1
        assert events[0]["source"] == "ghl"
        assert events[0]["replayed"] == 0

    def test_filter_by_source(self, conn):
        from packages.agencyu.sync.replay_buffer import get_replayable_events, store_event

        store_event(conn, source="ghl", event_type="lead.captured", payload={})
        store_event(conn, source="stripe", event_type="payment.paid", payload={})

        ghl_events = get_replayable_events(conn, source="ghl")
        assert len(ghl_events) == 1
        assert ghl_events[0]["source"] == "ghl"

    def test_mark_replayed(self, conn):
        from packages.agencyu.sync.replay_buffer import (
            get_replayable_events,
            mark_replayed,
            store_event,
        )

        eid = store_event(conn, source="ghl", event_type="lead.captured", payload={})
        mark_replayed(conn, eid)

        events = get_replayable_events(conn)
        assert len(events) == 0

        row = conn.execute("SELECT * FROM event_replay_buffer WHERE id=?", (eid,)).fetchone()
        assert row["replayed"] == 1
        assert row["replayed_at"] is not None

    def test_buffer_stats(self, conn):
        from packages.agencyu.sync.replay_buffer import get_buffer_stats, mark_replayed, store_event

        e1 = store_event(conn, source="ghl", event_type="a", payload={})
        store_event(conn, source="ghl", event_type="b", payload={})
        mark_replayed(conn, e1)

        stats = get_buffer_stats(conn)
        assert stats["total"] == 2
        assert stats["pending"] == 1
        assert stats["replayed"] == 1


# ── Capacity tests ──


class TestCapacity:
    def test_upsert_and_overview(self, conn):
        from packages.agencyu.sync.capacity import get_capacity_overview, upsert_team_capacity

        upsert_team_capacity(conn, team_member_id="tm1", display_name="Alice", role="designer", max_concurrent_work=5, current_open_work=2)
        upsert_team_capacity(conn, team_member_id="tm2", display_name="Bob", role="editor", max_concurrent_work=3, current_open_work=3)

        overview = get_capacity_overview(conn)
        assert overview["total_members"] == 2
        assert overview["available_members"] == 1  # Bob is at capacity
        assert overview["total_capacity"] == 8
        assert overview["total_load"] == 5

    def test_get_available_members(self, conn):
        from packages.agencyu.sync.capacity import get_available_members, upsert_team_capacity

        upsert_team_capacity(conn, team_member_id="tm1", display_name="Alice", role="designer", max_concurrent_work=5, current_open_work=2)
        upsert_team_capacity(conn, team_member_id="tm2", display_name="Bob", role="designer", max_concurrent_work=5, current_open_work=5)

        available = get_available_members(conn, role="designer")
        assert len(available) == 1
        assert available[0]["team_member_id"] == "tm1"

    def test_increment_decrement_load(self, conn):
        from packages.agencyu.sync.capacity import (
            decrement_load,
            increment_load,
            upsert_team_capacity,
        )

        upsert_team_capacity(conn, team_member_id="tm1", display_name="Alice", max_concurrent_work=5, current_open_work=2)

        increment_load(conn, "tm1")
        row = conn.execute("SELECT current_open_work FROM team_capacity_v2 WHERE team_member_id='tm1'").fetchone()
        assert row[0] == 3

        decrement_load(conn, "tm1")
        row = conn.execute("SELECT current_open_work FROM team_capacity_v2 WHERE team_member_id='tm1'").fetchone()
        assert row[0] == 2

    def test_decrement_floor_at_zero(self, conn):
        from packages.agencyu.sync.capacity import decrement_load, upsert_team_capacity

        upsert_team_capacity(conn, team_member_id="tm1", display_name="Alice", max_concurrent_work=5, current_open_work=0)
        decrement_load(conn, "tm1")
        row = conn.execute("SELECT current_open_work FROM team_capacity_v2 WHERE team_member_id='tm1'").fetchone()
        assert row[0] == 0

    def test_upsert_updates_existing(self, conn):
        from packages.agencyu.sync.capacity import upsert_team_capacity

        upsert_team_capacity(conn, team_member_id="tm1", display_name="Alice", max_concurrent_work=5, current_open_work=2)
        upsert_team_capacity(conn, team_member_id="tm1", display_name="Alice Updated", max_concurrent_work=10, current_open_work=0)

        row = conn.execute("SELECT * FROM team_capacity_v2 WHERE team_member_id='tm1'").fetchone()
        assert row["display_name"] == "Alice Updated"
        assert row["max_concurrent_work"] == 10

    def test_disabled_members_excluded(self, conn):
        from packages.agencyu.sync.capacity import (
            get_available_members,
            get_capacity_overview,
            upsert_team_capacity,
        )

        upsert_team_capacity(conn, team_member_id="tm1", display_name="Alice", max_concurrent_work=5, current_open_work=0, enabled=True)
        upsert_team_capacity(conn, team_member_id="tm2", display_name="Bob", max_concurrent_work=5, current_open_work=0, enabled=False)

        overview = get_capacity_overview(conn)
        assert overview["total_members"] == 1
        available = get_available_members(conn)
        assert len(available) == 1


# ── Revenue Forecast tests ──


class TestRevenueForecast:
    def test_compute_forecast(self, conn):
        from packages.agencyu.sync.revenue_forecast import compute_forecast

        result = compute_forecast(
            conn,
            forecast_month="2025-03",
            active_mrr=5000,
            pipeline_value=10000,
            booked_calls=3,
            historical_close_rate=0.25,
        )
        assert result["total_forecast"] == 7500
        assert result["projected_new_revenue"] == 2500
        assert result["active_mrr"] == 5000
        assert result["id"].startswith("rf_")

    def test_forecast_upsert(self, conn):
        from packages.agencyu.sync.revenue_forecast import compute_forecast, get_forecast

        compute_forecast(conn, forecast_month="2025-03", active_mrr=5000, pipeline_value=10000, historical_close_rate=0.25)
        compute_forecast(conn, forecast_month="2025-03", active_mrr=6000, pipeline_value=12000, historical_close_rate=0.3)

        f = get_forecast(conn, "2025-03")
        assert f is not None
        assert f["active_mrr"] == 6000
        assert f["total_forecast"] == 6000 + int(12000 * 0.3)

    def test_get_forecast_not_found(self, conn):
        from packages.agencyu.sync.revenue_forecast import get_forecast

        assert get_forecast(conn, "2099-01") is None

    def test_get_recent_forecasts(self, conn):
        from packages.agencyu.sync.revenue_forecast import compute_forecast, get_recent_forecasts

        for month in ["2025-01", "2025-02", "2025-03"]:
            compute_forecast(conn, forecast_month=month, active_mrr=1000)

        recent = get_recent_forecasts(conn, limit=2)
        assert len(recent) == 2
        # Should be ordered by month DESC
        assert recent[0]["forecast_month"] == "2025-03"

    def test_forecast_with_notes(self, conn):
        from packages.agencyu.sync.revenue_forecast import compute_forecast, get_forecast

        compute_forecast(conn, forecast_month="2025-04", active_mrr=3000, notes="Q2 projection")
        f = get_forecast(conn, "2025-04")
        assert f["notes"] == "Q2 projection"


# ── YAML Manifest loading ──


class TestYAMLManifest:
    def test_load_manifest(self):
        from packages.agencyu.notion.manifest_validator import load_yaml_manifest

        manifest = load_yaml_manifest()
        assert manifest["version"] == "2.1"
        assert "clients" in manifest["databases"]
        assert "work_orders" in manifest["databases"]
        assert "crm_pipeline" in manifest["databases"]
        assert "invoices" in manifest["databases"]
        # v2.0 additions
        assert "outcomes" in manifest["databases"]
        assert "projects" in manifest["databases"]
        assert "tasks" in manifest["databases"]
        assert "efforts" in manifest["databases"]

    def test_manifest_database_structure(self):
        from packages.agencyu.notion.manifest_validator import load_yaml_manifest

        manifest = load_yaml_manifest()
        clients = manifest["databases"]["clients"]
        assert clients["required"] is True
        assert "name" in clients["properties"]
        assert clients["properties"]["name"]["type"] == "title"
        assert "Active Clients" in clients["required_views"]

    def test_manifest_select_options(self):
        from packages.agencyu.notion.manifest_validator import load_yaml_manifest

        manifest = load_yaml_manifest()
        clients = manifest["databases"]["clients"]
        status_options = clients["properties"]["status"]["options"]
        assert "Lead" in status_options
        assert "Active" in status_options


# ── Config flag ──


class TestConfigFlags:
    def test_notion_write_lock_default(self):
        from packages.common.config import Settings

        s = Settings(SQLITE_PATH=":memory:")
        assert s.NOTION_WRITE_LOCK is False

    def test_notion_write_enabled_default(self):
        from packages.common.config import Settings

        s = Settings(SQLITE_PATH=":memory:")
        assert s.NOTION_WRITE_ENABLED is False
