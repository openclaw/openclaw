"""Tests for AgencyOS v3: Notion schema bootstrap, mirror writer,
ClickFunnels webhook normalization, and attribution engine."""

from __future__ import annotations

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


# ── DB schema tests ──


class TestV3Tables:
    def test_notion_bindings_table_exists(self, conn):
        conn.execute(
            "INSERT INTO notion_bindings (id, binding_type, notion_object_id, label, created_at, updated_at) "
            "VALUES ('nb1', 'CRM Pipeline', 'db_123', 'CRM', '2024-01-01', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM notion_bindings WHERE id='nb1'").fetchone()
        assert row["binding_type"] == "CRM Pipeline"

    def test_notion_bindings_unique_constraint(self, conn):
        conn.execute(
            "INSERT INTO notion_bindings (id, binding_type, notion_object_id, label, created_at, updated_at) "
            "VALUES ('nb1', 'CRM', 'db_123', 'CRM', '2024-01-01', '2024-01-01')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO notion_bindings (id, binding_type, notion_object_id, label, created_at, updated_at) "
                "VALUES ('nb2', 'CRM', 'db_123', 'CRM', '2024-01-01', '2024-01-01')"
            )

    def test_id_map_table_exists(self, conn):
        conn.execute(
            "INSERT INTO id_map (id, domain, external_id, notion_page_id, created_at, updated_at) "
            "VALUES ('im1', 'lead', 'ext_1', 'np_1', '2024-01-01', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM id_map WHERE id='im1'").fetchone()
        assert row["domain"] == "lead"

    def test_work_order_mirror_table_exists(self, conn):
        conn.execute(
            "INSERT INTO work_order_mirror (id, trello_card_id, board_id, status, created_at, updated_at) "
            "VALUES ('wom1', 'tc_1', 'b_1', 'In Progress', '2024-01-01', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM work_order_mirror WHERE id='wom1'").fetchone()
        assert row["status"] == "In Progress"

    def test_attribution_snapshot_table_exists(self, conn):
        conn.execute(
            "INSERT INTO attribution_snapshot (id, contact_key, utm_campaign, created_at, updated_at) "
            "VALUES ('as1', 'ck_1', 'summer_2024', '2024-01-01', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM attribution_snapshot WHERE id='as1'").fetchone()
        assert row["utm_campaign"] == "summer_2024"

    def test_clickfunnels_events_table_exists(self, conn):
        conn.execute(
            "INSERT INTO clickfunnels_events (id, event_type, email, payload_json, created_at) "
            "VALUES ('cfe1', 'clickfunnels.form_submitted', 'a@b.com', '{}', '2024-01-01')"
        )
        row = conn.execute("SELECT * FROM clickfunnels_events WHERE id='cfe1'").fetchone()
        assert row["event_type"] == "clickfunnels.form_submitted"


# ── Notion client rate limiter tests ──


class TestNotionRateLimiter:
    def test_acquire_does_not_raise(self):
        from packages.agencyu.notion.client import NotionRateLimiter

        limiter = NotionRateLimiter(rate=100.0)
        # Should not raise even with multiple rapid calls
        for _ in range(5):
            limiter.acquire()


# ── ClickFunnels webhook normalization ──


class TestClickFunnelsNormalization:
    def test_form_submitted_basic(self):
        from packages.agencyu.clickfunnels.webhook import normalize_clickfunnels_event

        payload = {
            "event": "clickfunnels.form_submitted",
            "contact": {"email": "test@example.com", "name": "Test User"},
            "funnel_id": "f123",
            "page_id": "p456",
            "utm_source": "meta",
            "utm_campaign": "summer",
        }
        event = normalize_clickfunnels_event(payload)
        assert event.event_type == "clickfunnels.form_submitted"
        assert event.email == "test@example.com"
        assert event.name == "Test User"
        assert event.funnel_id == "f123"
        assert event.utm_source == "meta"
        assert event.utm_campaign == "summer"

    def test_application_submitted_with_answers(self):
        from packages.agencyu.clickfunnels.webhook import normalize_clickfunnels_event

        payload = {
            "event": "clickfunnels.application_submitted",
            "email": "apply@test.com",
            "application_answers": {"budget": "5k-15k", "ig_handle": "@test"},
        }
        event = normalize_clickfunnels_event(payload)
        assert event.event_type == "clickfunnels.application_submitted"
        assert event.email == "apply@test.com"
        assert event.application_answers["budget"] == "5k-15k"

    def test_infers_application_type_from_answers(self):
        from packages.agencyu.clickfunnels.webhook import normalize_clickfunnels_event

        payload = {"email": "x@y.com", "answers": {"q1": "a1"}}
        event = normalize_clickfunnels_event(payload)
        assert event.event_type == "clickfunnels.application_submitted"

    def test_nested_utm_fallback(self):
        from packages.agencyu.clickfunnels.webhook import normalize_clickfunnels_event

        payload = {
            "event": "clickfunnels.form_submitted",
            "email": "x@y.com",
            "utm": {"source": "google", "medium": "cpc", "campaign": "winter"},
        }
        event = normalize_clickfunnels_event(payload)
        assert event.utm_source == "google"
        assert event.utm_medium == "cpc"
        assert event.utm_campaign == "winter"

    def test_store_clickfunnels_event(self, conn):
        from packages.agencyu.clickfunnels.webhook import (
            ClickFunnelsEvent,
            store_clickfunnels_event,
        )

        event = ClickFunnelsEvent(
            event_type="clickfunnels.form_submitted",
            email="store@test.com",
            funnel_id="f1",
            raw_payload={"test": True},
        )
        event_id = store_clickfunnels_event(conn, event, correlation_id="corr_1")
        assert event_id.startswith("cfe_")

        row = conn.execute("SELECT * FROM clickfunnels_events WHERE id=?", (event_id,)).fetchone()
        assert row["email"] == "store@test.com"
        assert row["correlation_id"] == "corr_1"


# ── Attribution engine ──


class TestAttributionEngine:
    def test_extract_from_payload_basic(self, conn):
        from packages.agencyu.attribution.engine import AttributionEngine

        engine = AttributionEngine(conn)
        update = engine.extract_from_payload({
            "email": "test@example.com",
            "utm_source": "meta",
            "utm_campaign": "summer",
        })
        assert update is not None
        assert update.contact_key == "test@example.com"
        assert update.utm_source == "meta"

    def test_extract_returns_none_without_contact(self, conn):
        from packages.agencyu.attribution.engine import AttributionEngine

        engine = AttributionEngine(conn)
        update = engine.extract_from_payload({"utm_source": "meta"})
        assert update is None

    def test_record_and_get_snapshot(self, conn):
        from packages.agencyu.attribution.engine import AttributionEngine, AttributionUpdate

        engine = AttributionEngine(conn)
        update = AttributionUpdate(
            contact_key="ghl_123",
            utm_source="meta",
            utm_campaign="summer_2024",
            ghl_contact_id="ghl_123",
            revenue_cents=50000,
        )
        snap_id = engine.record_snapshot(update)
        assert snap_id.startswith("attr_")

        snapshot = engine.get_snapshot("ghl_123")
        assert snapshot is not None
        assert snapshot["utm_campaign"] == "summer_2024"
        assert snapshot["revenue_cents"] == 50000

    def test_record_snapshot_updates_existing(self, conn):
        from packages.agencyu.attribution.engine import AttributionEngine, AttributionUpdate

        engine = AttributionEngine(conn)
        u1 = AttributionUpdate(contact_key="ck_1", utm_source="meta", utm_campaign="camp1")
        id1 = engine.record_snapshot(u1)

        u2 = AttributionUpdate(contact_key="ck_1", utm_medium="cpc", stripe_payment_id="pi_1", revenue_cents=10000)
        id2 = engine.record_snapshot(u2)

        # Should update existing, not create new
        assert id2 == id1

        snap = engine.get_snapshot("ck_1")
        assert snap["utm_source"] == "meta"  # preserved from first
        assert snap["utm_medium"] == "cpc"  # added from second
        assert snap["revenue_cents"] == 10000

    def test_campaign_roas(self, conn):
        from packages.agencyu.attribution.engine import AttributionEngine, AttributionUpdate

        engine = AttributionEngine(conn)
        # Two leads, one paid
        engine.record_snapshot(AttributionUpdate(
            contact_key="l1", utm_campaign="camp", stripe_payment_id="pi_1", revenue_cents=50000,
        ))
        engine.record_snapshot(AttributionUpdate(
            contact_key="l2", utm_campaign="camp",
        ))

        roas = engine.get_campaign_roas("camp")
        assert roas["lead_count"] == 2
        assert roas["paid_count"] == 1
        assert roas["total_revenue_cents"] == 50000
        assert roas["close_rate"] == 0.5


# ── Schema bootstrapper ──


class TestSchemaBootstrapper:
    def test_plan_shows_will_create(self, conn):
        from packages.agencyu.notion.schema_bootstrap import NotionSchemaBootstrapper

        notion = MagicMock()
        bootstrapper = NotionSchemaBootstrapper(conn, notion, root_page_id="rp_1")
        plan = bootstrapper.plan()
        assert len(plan.databases) == 4
        assert all(d["action"] == "will_create" for d in plan.databases)

    def test_plan_shows_already_bound(self, conn):
        from packages.agencyu.notion.schema_bootstrap import NotionSchemaBootstrapper

        # Pre-bind CRM Pipeline
        conn.execute(
            "INSERT INTO notion_bindings (id, binding_type, notion_object_id, label, created_at, updated_at) "
            "VALUES ('nb1', 'CRM Pipeline', 'db_crm', 'CRM', '2024-01-01', '2024-01-01')"
        )
        conn.commit()

        notion = MagicMock()
        bootstrapper = NotionSchemaBootstrapper(conn, notion, root_page_id="rp_1")
        plan = bootstrapper.plan()
        assert len(plan.databases) == 3  # 4 - 1 already bound
        assert len(plan.bindings) == 1
        assert plan.bindings[0]["action"] == "already_bound"

    @patch("packages.agencyu.notion.schema_bootstrap.settings")
    def test_execute_dry_run(self, mock_settings, conn):
        mock_settings.DRY_RUN = True
        mock_settings.NOTION_WRITE_ENABLED = False
        mock_settings.NOTION_ROOT_PAGE_ID = "rp_1"

        from packages.agencyu.notion.schema_bootstrap import NotionSchemaBootstrapper

        notion = MagicMock()
        bootstrapper = NotionSchemaBootstrapper(conn, notion, root_page_id="rp_1")
        result = bootstrapper.execute()
        assert result["dry_run"] is True
        notion.create_database.assert_not_called()


# ── Notion mirror writer ──


class TestNotionMirror:
    @patch("packages.agencyu.notion.notion_mirror.settings")
    def test_sync_work_order_dry_run(self, mock_settings, conn):
        mock_settings.DRY_RUN = True
        mock_settings.NOTION_WRITE_ENABLED = False
        mock_settings.KILL_SWITCH = False

        from packages.agencyu.notion.notion_mirror import NotionMirror, NotionMirrorConfig

        notion = MagicMock()
        config = NotionMirrorConfig(sync_work_orders=True, write_enabled=False)
        mirror = NotionMirror(conn, notion, config)

        result = mirror.sync_work_order(
            trello_card_id="tc_1",
            board_id="b_1",
            title="Test Card",
            status="In Progress",
        )
        assert result["dry_run"] is True
        assert result["action"] == "create"
        notion.create_page.assert_not_called()

    def test_sync_work_orders_disabled(self, conn):
        from packages.agencyu.notion.notion_mirror import NotionMirror, NotionMirrorConfig

        notion = MagicMock()
        config = NotionMirrorConfig(sync_work_orders=False)
        mirror = NotionMirror(conn, notion, config)

        result = mirror.sync_work_order(
            trello_card_id="tc_1", board_id="b_1", title="Test", status="New",
        )
        assert result["skipped"] is True

    @patch("packages.agencyu.notion.notion_mirror.settings")
    def test_sync_crm_lead_dry_run(self, mock_settings, conn):
        mock_settings.DRY_RUN = True
        mock_settings.NOTION_WRITE_ENABLED = False
        mock_settings.KILL_SWITCH = False

        from packages.agencyu.notion.notion_mirror import NotionMirror, NotionMirrorConfig

        # Insert a test lead
        conn.execute(
            """INSERT INTO agencyu_leads
               (id, created_at, updated_at, stage, instagram_handle, email, ghl_contact_id, manychat_contact_id)
               VALUES ('l1', '2024-01-01', '2024-01-01', 'qualified', '@testuser', 'test@x.com', 'ghl_1', 'mc_1')"""
        )
        conn.commit()

        notion = MagicMock()
        config = NotionMirrorConfig(sync_crm=True, write_enabled=False)
        mirror = NotionMirror(conn, notion, config)

        result = mirror.sync_crm_lead(lead_id="l1")
        assert result["dry_run"] is True
        assert result["name"] == "@testuser"

    def test_sync_crm_lead_not_found(self, conn):
        from packages.agencyu.notion.notion_mirror import NotionMirror

        notion = MagicMock()
        mirror = NotionMirror(conn, notion)

        result = mirror.sync_crm_lead(lead_id="nonexistent")
        assert result["error"] == "lead_not_found"

    def test_get_sync_status(self, conn):
        from packages.agencyu.notion.notion_mirror import NotionMirror

        notion = MagicMock()
        mirror = NotionMirror(conn, notion)

        status = mirror.get_sync_status()
        assert status["work_order_mirrors"] == 0
        assert status["notion_mirrors"] == 0
        assert status["bindings"] == 0
