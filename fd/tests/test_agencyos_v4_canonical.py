"""Tests for AgencyOS v4: canonical entity store, manifest, compliance,
drift detection, sync orchestrator, and conflict resolution."""

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


class TestV4Tables:
    def test_canonical_entities_table(self, conn):
        conn.execute(
            "INSERT INTO canonical_entities (id, entity_type, data_json, content_hash, created_at, updated_at) "
            "VALUES ('ce1', 'client', '{}', 'abc', '2024-01-01', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM canonical_entities WHERE id='ce1'").fetchone()
        assert row["entity_type"] == "client"

    def test_entity_mappings_table(self, conn):
        conn.execute(
            "INSERT INTO canonical_entities (id, entity_type, data_json, content_hash, created_at, updated_at) "
            "VALUES ('ce1', 'task', '{}', 'abc', '2024-01-01', '2024-01-01')"
        )
        conn.execute(
            "INSERT INTO entity_mappings (id, entity_id, source_system, source_type, source_id, created_at) "
            "VALUES ('em1', 'ce1', 'trello', 'card', 'tc_123', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM entity_mappings WHERE id='em1'").fetchone()
        assert row["source_system"] == "trello"

    def test_entity_mappings_unique_constraint(self, conn):
        conn.execute(
            "INSERT INTO canonical_entities (id, entity_type, data_json, content_hash, created_at, updated_at) "
            "VALUES ('ce1', 'task', '{}', 'abc', '2024-01-01', '2024-01-01')"
        )
        conn.execute(
            "INSERT INTO entity_mappings (id, entity_id, source_system, source_type, source_id, created_at) "
            "VALUES ('em1', 'ce1', 'trello', 'card', 'tc_123', '2024-01-01')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO entity_mappings (id, entity_id, source_system, source_type, source_id, created_at) "
                "VALUES ('em2', 'ce1', 'trello', 'card', 'tc_123', '2024-01-01')"
            )

    def test_notion_mirror_state_table(self, conn):
        conn.execute(
            "INSERT INTO canonical_entities (id, entity_type, data_json, content_hash, created_at, updated_at) "
            "VALUES ('ce1', 'task', '{}', 'abc', '2024-01-01', '2024-01-01')"
        )
        conn.execute(
            "INSERT INTO notion_mirror_state (entity_id, notion_database_key, sync_health) "
            "VALUES ('ce1', 'tasks', 'ok')"
        )
        row = conn.execute("SELECT * FROM notion_mirror_state WHERE entity_id='ce1'").fetchone()
        assert row["notion_database_key"] == "tasks"

    def test_conflict_log_table(self, conn):
        conn.execute(
            "INSERT INTO conflict_log (id, entity_id, entity_type, field_name, policy_applied, created_at) "
            "VALUES ('cl1', 'ce1', 'task', 'status', 'source_wins', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM conflict_log WHERE id='cl1'").fetchone()
        assert row["policy_applied"] == "source_wins"

    def test_sync_runs_table(self, conn):
        conn.execute(
            "INSERT INTO sync_runs (id, source_system, status, started_at) "
            "VALUES ('sr1', 'trello', 'running', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM sync_runs WHERE id='sr1'").fetchone()
        assert row["source_system"] == "trello"


# ── Stable hashing ──


class TestStableHashing:
    def test_same_payload_same_hash(self):
        from packages.agencyu.canonical.hashing import stable_hash

        payload = {"name": "Test", "status": "active", "value": 42}
        assert stable_hash(payload) == stable_hash(payload)

    def test_key_order_irrelevant(self):
        from packages.agencyu.canonical.hashing import stable_hash

        p1 = {"b": 2, "a": 1}
        p2 = {"a": 1, "b": 2}
        assert stable_hash(p1) == stable_hash(p2)

    def test_different_payload_different_hash(self):
        from packages.agencyu.canonical.hashing import stable_hash

        p1 = {"name": "A"}
        p2 = {"name": "B"}
        assert stable_hash(p1) != stable_hash(p2)


# ── Canonical mapper ──


class TestCanonicalMapper:
    def test_upsert_creates_entity_and_mapping(self, conn):
        from packages.agencyu.canonical.mapper import upsert_canonical_entity

        entity_id = upsert_canonical_entity(
            conn,
            entity_type="task",
            canonical_key="task_001",
            data={"name": "Test Task", "status": "To Do"},
            source_system="trello",
            source_type="card",
            source_id="tc_abc",
        )
        assert entity_id.startswith("ce_")

        entity = conn.execute("SELECT * FROM canonical_entities WHERE id=?", (entity_id,)).fetchone()
        assert entity["entity_type"] == "task"
        assert json.loads(entity["data_json"])["name"] == "Test Task"

        mapping = conn.execute("SELECT * FROM entity_mappings WHERE entity_id=?", (entity_id,)).fetchone()
        assert mapping["source_system"] == "trello"
        assert mapping["source_id"] == "tc_abc"

    def test_upsert_updates_existing(self, conn):
        from packages.agencyu.canonical.mapper import upsert_canonical_entity

        id1 = upsert_canonical_entity(
            conn, entity_type="task", canonical_key=None,
            data={"name": "V1"}, source_system="trello", source_type="card", source_id="tc_1",
        )
        id2 = upsert_canonical_entity(
            conn, entity_type="task", canonical_key=None,
            data={"name": "V2"}, source_system="trello", source_type="card", source_id="tc_1",
        )
        assert id1 == id2

        entity = conn.execute("SELECT * FROM canonical_entities WHERE id=?", (id1,)).fetchone()
        assert json.loads(entity["data_json"])["name"] == "V2"

    def test_find_by_source(self, conn):
        from packages.agencyu.canonical.mapper import find_entity_by_source, upsert_canonical_entity

        upsert_canonical_entity(
            conn, entity_type="client", canonical_key="c1",
            data={"name": "Acme"}, source_system="stripe", source_type="customer", source_id="cus_1",
        )

        found = find_entity_by_source(conn, source_system="stripe", source_type="customer", source_id="cus_1")
        assert found is not None
        assert found["data"]["name"] == "Acme"

    def test_find_by_source_not_found(self, conn):
        from packages.agencyu.canonical.mapper import find_entity_by_source

        found = find_entity_by_source(conn, source_system="x", source_type="y", source_id="z")
        assert found is None

    def test_add_source_mapping(self, conn):
        from packages.agencyu.canonical.mapper import add_source_mapping, upsert_canonical_entity

        eid = upsert_canonical_entity(
            conn, entity_type="client", canonical_key=None,
            data={"name": "Test"}, source_system="ghl", source_type="contact", source_id="ghl_1",
        )
        add_source_mapping(conn, entity_id=eid, source_system="stripe", source_type="customer", source_id="cus_1")

        mappings = conn.execute("SELECT * FROM entity_mappings WHERE entity_id=?", (eid,)).fetchall()
        assert len(mappings) == 2

    def test_soft_delete(self, conn):
        from packages.agencyu.canonical.mapper import soft_delete_entity, upsert_canonical_entity

        eid = upsert_canonical_entity(
            conn, entity_type="task", canonical_key=None,
            data={"name": "X"}, source_system="trello", source_type="card", source_id="tc_1",
        )
        soft_delete_entity(conn, eid)

        entity = conn.execute("SELECT * FROM canonical_entities WHERE id=?", (eid,)).fetchone()
        assert entity["is_deleted"] == 1
        assert entity["deleted_at"] is not None


# ── Manifest loading ──


class TestManifest:
    def test_load_manifest_from_json(self):
        import json as json_mod
        from pathlib import Path

        from packages.agencyu.notion_os.manifest import load_manifest_from_json

        manifest_path = Path(__file__).resolve().parent.parent / "packages/agencyu/notion/template_manifest.json"
        data = json_mod.loads(manifest_path.read_text())
        manifest = load_manifest_from_json(data)

        assert manifest.manifest_version == "2026-02-28"
        assert manifest.root_page_title == "Full Digital — AgencyOS"
        assert len(manifest.required_child_pages) == 7
        assert len(manifest.databases) == 14

        # Verify a specific database
        clients_db = next(d for d in manifest.databases if d.key == "clients")
        assert clients_db.name == "Clients"
        assert clients_db.primary_title_property == "Client Name"
        assert len(clients_db.required_views) == 3
        prop_names = [p.name for p in clients_db.properties]
        assert "Status" in prop_names
        assert "MRR" in prop_names
        assert "canonical_id" in prop_names


# ── Drift detection ──


class TestDrift:
    def test_no_drift(self):
        from packages.agencyu.canonical.hashing import stable_hash
        from packages.agencyu.notion_os.drift import compute_drift

        payload = {"name": "Test", "status": "active"}
        h = stable_hash(payload)
        result = compute_drift(payload, payload, h)
        assert result.has_drift is False

    def test_external_drift(self):
        from packages.agencyu.canonical.hashing import stable_hash
        from packages.agencyu.notion_os.drift import compute_drift

        old_payload = {"name": "V1"}
        new_payload = {"name": "V2"}
        h = stable_hash(old_payload)
        result = compute_drift(new_payload, old_payload, h)
        assert result.has_drift is True
        assert result.drift_type == "external"

    def test_local_drift(self):
        from packages.agencyu.canonical.hashing import stable_hash
        from packages.agencyu.notion_os.drift import compute_drift

        payload = {"name": "V1"}
        notion_changed = {"name": "V1_notion_edit"}
        h = stable_hash(payload)
        result = compute_drift(payload, notion_changed, h)
        assert result.has_drift is True
        assert result.drift_type == "local"

    def test_dual_drift(self):
        from packages.agencyu.canonical.hashing import stable_hash
        from packages.agencyu.notion_os.drift import compute_drift

        old = {"name": "V1"}
        new_source = {"name": "V2_source"}
        new_notion = {"name": "V2_notion"}
        h = stable_hash(old)
        result = compute_drift(new_source, new_notion, h)
        assert result.has_drift is True
        assert result.drift_type == "dual"

    def test_never_mirrored(self):
        from packages.agencyu.notion_os.drift import compute_drift

        result = compute_drift({"name": "V1"}, {"name": "V1"}, None)
        assert result.has_drift is True
        assert result.drift_type == "external"
        assert result.details["reason"] == "never_mirrored"


# ── Conflict resolution ──


class TestConflictResolution:
    def test_source_wins_default(self):
        from packages.agencyu.sync.conflict import resolve_field_conflict

        value, policy = resolve_field_conflict(
            field_name="status",
            source_value="In Progress",
            notion_value="Done",
            override_owner=None,
        )
        assert value == "In Progress"
        assert policy == "source_wins"

    def test_notion_override(self):
        from packages.agencyu.sync.conflict import resolve_field_conflict

        value, policy = resolve_field_conflict(
            field_name="status",
            source_value="In Progress",
            notion_value="Done",
            override_owner="notion",
        )
        assert value == "Done"
        assert policy == "notion_override"

    def test_system_override(self):
        from packages.agencyu.sync.conflict import resolve_field_conflict

        value, policy = resolve_field_conflict(
            field_name="status",
            source_value="V1",
            notion_value="V2",
            override_owner="system",
        )
        assert value == "V1"
        assert policy == "system_override"


# ── Sync orchestrator ──


class TestSyncOrchestrator:
    def test_start_and_finish_run(self, conn):
        from packages.agencyu.sync.orchestrator import SyncOrchestrator

        orch = SyncOrchestrator(conn)
        run_id = orch.start_run("trello")
        assert run_id.startswith("sr_")

        row = conn.execute("SELECT * FROM sync_runs WHERE id=?", (run_id,)).fetchone()
        assert row["status"] == "running"

        orch.finish_run(run_id, status="success", stats={"created": 5, "updated": 3})
        row = conn.execute("SELECT * FROM sync_runs WHERE id=?", (run_id,)).fetchone()
        assert row["status"] == "success"
        assert row["finished_at"] is not None

    def test_record_conflict(self, conn):
        from packages.agencyu.sync.orchestrator import SyncOrchestrator

        orch = SyncOrchestrator(conn)
        run_id = orch.start_run("trello")
        conflict_id = orch.record_conflict(
            sync_run_id=run_id,
            entity_id="ce_1",
            entity_type="task",
            field_name="status",
            policy_applied="source_wins",
            source_value="In Progress",
            notion_value="Done",
            resolved_value="In Progress",
        )
        assert conflict_id.startswith("cl_")

        conflicts = orch.get_conflicts(entity_id="ce_1")
        assert len(conflicts) == 1
        assert conflicts[0]["field_name"] == "status"

    def test_get_sync_overview(self, conn):
        from packages.agencyu.sync.orchestrator import SyncOrchestrator

        orch = SyncOrchestrator(conn)
        overview = orch.get_sync_overview()
        assert overview["canonical_entities"] == 0
        assert overview["entity_mappings"] == 0
        assert overview["unresolved_conflicts"] == 0

    def test_get_recent_runs_empty(self, conn):
        from packages.agencyu.sync.orchestrator import SyncOrchestrator

        orch = SyncOrchestrator(conn)
        runs = orch.get_recent_runs()
        assert runs == []


# ── Compliance validator ──


class TestComplianceValidator:
    def test_validate_compliant_workspace(self):
        import json as json_mod
        from pathlib import Path

        from packages.agencyu.notion_os.compliance import NotionComplianceValidator
        from packages.agencyu.notion_os.manifest import load_manifest_from_json

        manifest_path = Path(__file__).resolve().parent.parent / "packages/agencyu/notion/template_manifest.json"
        manifest = load_manifest_from_json(json_mod.loads(manifest_path.read_text()))

        # Create a mock Notion client that returns a compliant workspace
        mock_notion = MagicMock()
        mock_notion.get_page.return_value = {"title": "Full Digital — AgencyOS"}
        mock_notion.list_child_pages.return_value = [
            {"title": t} for t in manifest.required_child_pages
        ]

        # Create compliant database schemas
        databases = []
        for db_spec in manifest.databases:
            schema = {}
            for prop in db_spec.properties:
                prop_info = {"type": prop.type}
                if prop.options:
                    prop_info["options"] = prop.options
                schema[prop.name] = prop_info
            databases.append({"id": f"db_{db_spec.key}", "name": db_spec.name, "schema": schema})

        mock_notion.discover_databases_under_root.return_value = databases
        mock_notion.list_database_views.return_value = []

        validator = NotionComplianceValidator(mock_notion)
        report = validator.validate("root_page_id", manifest)

        # Should pass (only warnings for missing views)
        assert report.passed is True
        error_issues = [i for i in report.issues if i.severity == "error"]
        assert len(error_issues) == 0

    def test_validate_missing_database(self):
        from packages.agencyu.notion_os.compliance import NotionComplianceValidator
        from packages.agencyu.notion_os.manifest import DatabaseSpec, PropertySpec, TemplateManifest

        manifest = TemplateManifest(
            manifest_version="test",
            root_page_title="Test",
            required_child_pages=[],
            databases=[
                DatabaseSpec(
                    key="clients", name="Clients", primary_title_property="Name",
                    properties=[PropertySpec(name="Name", type="title")],
                    required_views=[],
                ),
            ],
        )

        mock_notion = MagicMock()
        mock_notion.get_page.return_value = {"title": "Test"}
        mock_notion.list_child_pages.return_value = []
        mock_notion.discover_databases_under_root.return_value = []

        validator = NotionComplianceValidator(mock_notion)
        report = validator.validate("rp", manifest)

        assert report.passed is False
        assert any(i.message == "Missing required database" for i in report.issues)

    def test_validate_missing_property(self):
        from packages.agencyu.notion_os.compliance import NotionComplianceValidator
        from packages.agencyu.notion_os.manifest import DatabaseSpec, PropertySpec, TemplateManifest

        manifest = TemplateManifest(
            manifest_version="test",
            root_page_title="Test",
            required_child_pages=[],
            databases=[
                DatabaseSpec(
                    key="clients", name="Clients", primary_title_property="Name",
                    properties=[
                        PropertySpec(name="Name", type="title"),
                        PropertySpec(name="MissingProp", type="number"),
                    ],
                    required_views=[],
                ),
            ],
        )

        mock_notion = MagicMock()
        mock_notion.get_page.return_value = {"title": "Test"}
        mock_notion.list_child_pages.return_value = []
        mock_notion.discover_databases_under_root.return_value = [
            {"id": "db1", "name": "Clients", "schema": {"Name": {"type": "title"}}},
        ]

        validator = NotionComplianceValidator(mock_notion)
        report = validator.validate("rp", manifest)

        assert report.passed is False
        missing = [i for i in report.issues if i.message == "Missing required property"]
        assert len(missing) == 1
        assert missing[0].details["property"] == "MissingProp"


# ── Canonical Notion Mirror ──


class TestCanonicalNotionMirror:
    @patch("packages.agencyu.notion_os.mirror.settings")
    def test_sync_entity_dry_run(self, mock_settings, conn):
        mock_settings.DRY_RUN = True
        mock_settings.NOTION_WRITE_ENABLED = False
        mock_settings.KILL_SWITCH = False

        from packages.agencyu.notion_os.mirror import CanonicalNotionMirror

        notion = MagicMock()
        mirror = CanonicalNotionMirror(conn, notion)

        result = mirror.sync_entity(
            entity_id="ce_1",
            database_key="tasks",
            database_id="db_tasks",
            canonical_payload={"name": "Test"},
            notion_properties={"Name": {"title": [{"text": {"content": "Test"}}]}},
        )
        assert result["dry_run"] is True
        assert result["action"] == "create"
        notion.create_page.assert_not_called()

    def test_get_mirror_stats_empty(self, conn):
        from packages.agencyu.notion_os.mirror import CanonicalNotionMirror

        notion = MagicMock()
        mirror = CanonicalNotionMirror(conn, notion)
        stats = mirror.get_mirror_stats()
        assert stats["total_mirrored"] == 0
        assert stats["healthy"] == 0
