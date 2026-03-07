"""Tests for AgencyOS v6: intelligence layer (client health, churn risk,
campaign integrity), boot-time system validator, and new DB tables."""

from __future__ import annotations

import sqlite3
from unittest.mock import patch

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


# ── New table existence tests ──


class TestV6Tables:
    def test_client_health_scores_table(self, conn):
        conn.execute(
            "INSERT INTO client_health_scores "
            "(client_id, display_name, health_score, churn_risk, churn_score, "
            "revenue_score, engagement_score, responsiveness_score, "
            "overdue_invoices, active_tasks, created_at, updated_at) "
            "VALUES ('c1', 'Acme', 75, 'low', 10, 80, 70, 60, 0, 3, '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM client_health_scores WHERE client_id='c1'").fetchone()
        assert row["display_name"] == "Acme"
        assert row["health_score"] == 75

    def test_campaign_integrity_table(self, conn):
        conn.execute(
            "INSERT INTO campaign_integrity "
            "(utm_campaign, source, total_leads, booked_calls, closed_won, "
            "total_revenue_cents, ad_spend_cents, roas, close_rate, "
            "integrity_status, created_at, updated_at) "
            "VALUES ('spring_2025', 'instagram', 50, 10, 5, 250000, 50000, 5.0, 0.1, 'ok', '2025-01-01', '2025-01-01')"
        )
        row = conn.execute("SELECT * FROM campaign_integrity WHERE utm_campaign='spring_2025'").fetchone()
        assert row["total_leads"] == 50
        assert row["roas"] == 5.0

    def test_boot_validations_table(self, conn):
        conn.execute(
            "INSERT INTO boot_validations (id, subsystem, status, details, validated_at) "
            "VALUES ('bv1', 'notion', 'ok', 'All good', '2025-01-01T00:00:00Z')"
        )
        row = conn.execute("SELECT * FROM boot_validations WHERE id='bv1'").fetchone()
        assert row["subsystem"] == "notion"
        assert row["status"] == "ok"


# ── Client Health Score tests ──


class TestClientHealth:
    def test_compute_health_score(self):
        from packages.agencyu.intelligence.client_health import compute_health_score

        score = compute_health_score(
            revenue_score=80,
            engagement_score=70,
            responsiveness_score=60,
            overdue_invoices=0,
        )
        # 80*0.3 + 70*0.35 + 60*0.2 + 100*0.15 = 24 + 24.5 + 12 + 15 = 75.5 → 75
        assert score == 75

    def test_health_score_with_overdue(self):
        from packages.agencyu.intelligence.client_health import compute_health_score

        score = compute_health_score(
            revenue_score=80,
            engagement_score=70,
            responsiveness_score=60,
            overdue_invoices=2,
        )
        # payment_score = max(0, 100-100) = 0
        # 80*0.3 + 70*0.35 + 60*0.2 + 0*0.15 = 24 + 24.5 + 12 + 0 = 60.5 → 60
        assert score == 60

    def test_health_score_clamped(self):
        from packages.agencyu.intelligence.client_health import compute_health_score

        score = compute_health_score(revenue_score=0, engagement_score=0, responsiveness_score=0, overdue_invoices=5)
        assert score == 0

    def test_compute_churn_risk_low(self):
        from packages.agencyu.intelligence.client_health import compute_churn_risk

        level, score = compute_churn_risk(
            days_since_last_meeting=10,
            days_since_last_task=5,
            overdue_invoices=0,
            engagement_score=50,
        )
        assert level == "low"
        assert score == 0

    def test_compute_churn_risk_medium(self):
        from packages.agencyu.intelligence.client_health import compute_churn_risk

        level, score = compute_churn_risk(
            days_since_last_meeting=35,  # +30
            days_since_last_task=5,
            overdue_invoices=0,
            engagement_score=50,
        )
        assert level == "medium"
        assert score == 30

    def test_compute_churn_risk_high(self):
        from packages.agencyu.intelligence.client_health import compute_churn_risk

        level, score = compute_churn_risk(
            days_since_last_meeting=45,  # +30
            days_since_last_task=20,  # +25
            overdue_invoices=1,  # +25
            engagement_score=20,  # +20
        )
        assert level == "high"
        assert score == 100

    def test_upsert_and_get_churn_risks(self, conn):
        from packages.agencyu.intelligence.client_health import (
            get_churn_risks,
            upsert_client_health,
        )

        upsert_client_health(
            conn,
            client_id="c1",
            display_name="Acme",
            health_score=30,
            churn_risk="high",
            churn_score=80,
        )
        upsert_client_health(
            conn,
            client_id="c2",
            display_name="Beta Corp",
            health_score=80,
            churn_risk="low",
            churn_score=10,
        )

        risks = get_churn_risks(conn, min_risk="medium")
        assert len(risks) == 1
        assert risks[0]["client_id"] == "c1"

    def test_get_all_health_scores(self, conn):
        from packages.agencyu.intelligence.client_health import (
            get_all_health_scores,
            upsert_client_health,
        )

        upsert_client_health(conn, client_id="c1", display_name="Acme", health_score=30, churn_risk="high", churn_score=80)
        upsert_client_health(conn, client_id="c2", display_name="Beta", health_score=90, churn_risk="low", churn_score=5)

        scores = get_all_health_scores(conn)
        assert len(scores) == 2
        # Worst first
        assert scores[0]["client_id"] == "c1"

    def test_health_summary(self, conn):
        from packages.agencyu.intelligence.client_health import (
            get_health_summary,
            upsert_client_health,
        )

        upsert_client_health(conn, client_id="c1", display_name="A", health_score=40, churn_risk="high", churn_score=70)
        upsert_client_health(conn, client_id="c2", display_name="B", health_score=60, churn_risk="medium", churn_score=40)
        upsert_client_health(conn, client_id="c3", display_name="C", health_score=90, churn_risk="low", churn_score=10)

        summary = get_health_summary(conn)
        assert summary["total_clients"] == 3
        assert summary["churn_risk_high"] == 1
        assert summary["churn_risk_medium"] == 1
        assert summary["churn_risk_low"] == 1

    def test_upsert_updates_existing(self, conn):
        from packages.agencyu.intelligence.client_health import upsert_client_health

        upsert_client_health(conn, client_id="c1", display_name="Acme", health_score=50, churn_risk="medium", churn_score=40)
        upsert_client_health(conn, client_id="c1", display_name="Acme Updated", health_score=80, churn_risk="low", churn_score=10)

        row = conn.execute("SELECT * FROM client_health_scores WHERE client_id='c1'").fetchone()
        assert row["display_name"] == "Acme Updated"
        assert row["health_score"] == 80


# ── Campaign Integrity tests ──


class TestCampaignIntegrity:
    def _seed_attribution(self, conn):
        """Seed attribution_snapshot data for campaign tests."""
        for i, (campaign, has_payment, revenue) in enumerate([
            ("spring_2025", True, 5000),
            ("spring_2025", True, 3000),
            ("spring_2025", False, 0),
            ("summer_2025", True, 10000),
            ("summer_2025", False, 0),
        ]):
            conn.execute(
                "INSERT INTO attribution_snapshot "
                "(id, contact_key, utm_source, utm_medium, utm_campaign, "
                "first_touch_ts, last_touch_ts, ghl_contact_id, stripe_payment_id, "
                "revenue_cents, created_at, updated_at) "
                "VALUES (?, ?, 'instagram', 'paid', ?, '2025-01-01', '2025-01-01', ?, ?, ?, '2025-01-01', '2025-01-01')",
                (
                    f"attr_{i}",
                    f"contact_{i}",
                    campaign,
                    f"ghl_{i}",
                    f"pi_{i}" if has_payment else None,
                    revenue,
                ),
            )
        conn.commit()

    def test_refresh_campaign_integrity(self, conn):
        from packages.agencyu.intelligence.campaign_integrity import refresh_campaign_integrity

        self._seed_attribution(conn)
        results = refresh_campaign_integrity(conn)
        assert len(results) == 2

        spring = next(r for r in results if r["utm_campaign"] == "spring_2025")
        assert spring["total_leads"] == 3
        assert spring["closed_won"] == 2
        assert spring["total_revenue_cents"] == 8000

    def test_get_campaign_integrity(self, conn):
        from packages.agencyu.intelligence.campaign_integrity import (
            get_campaign_integrity,
            refresh_campaign_integrity,
        )

        self._seed_attribution(conn)
        refresh_campaign_integrity(conn)

        all_campaigns = get_campaign_integrity(conn)
        assert len(all_campaigns) == 2

    def test_integrity_issues_flagged(self, conn):
        """Campaigns with orphaned revenue should be flagged."""
        # Insert a record with revenue but no stripe_payment_id
        conn.execute(
            "INSERT INTO attribution_snapshot "
            "(id, contact_key, utm_campaign, utm_source, "
            "first_touch_ts, last_touch_ts, revenue_cents, created_at, updated_at) "
            "VALUES ('a1', 'c1', 'test_campaign', 'ig', '2025-01-01', '2025-01-01', 5000, '2025-01-01', '2025-01-01')"
        )
        conn.commit()

        from packages.agencyu.intelligence.campaign_integrity import refresh_campaign_integrity

        results = refresh_campaign_integrity(conn)
        test = next(r for r in results if r["utm_campaign"] == "test_campaign")
        assert test["integrity_status"] == "warning"
        assert any("orphaned_revenue" in i for i in test["issues"])

    def test_set_ad_spend(self, conn):
        from packages.agencyu.intelligence.campaign_integrity import (
            get_campaign_integrity,
            set_ad_spend,
        )

        set_ad_spend(conn, utm_campaign="test_campaign", ad_spend_cents=25000)
        campaigns = get_campaign_integrity(conn)
        assert len(campaigns) == 1
        assert campaigns[0]["ad_spend_cents"] == 25000

    def test_integrity_summary(self, conn):
        from packages.agencyu.intelligence.campaign_integrity import (
            get_integrity_summary,
            refresh_campaign_integrity,
        )

        self._seed_attribution(conn)
        refresh_campaign_integrity(conn)

        summary = get_integrity_summary(conn)
        assert summary["total_campaigns"] == 2
        assert summary["total_revenue_cents"] == 18000


# ── Boot Validator tests ──


class TestBootValidator:
    def test_validate_all(self, conn):
        from packages.agencyu.boot.system_validator import SystemValidator

        validator = SystemValidator(conn)

        with patch("packages.agencyu.boot.system_validator.settings") as mock_settings:
            mock_settings.NOTION_API_KEY = ""
            mock_settings.NOTION_ROOT_PAGE_ID = ""
            mock_settings.TRELLO_KEY = "tk"
            mock_settings.TRELLO_TOKEN = "tt"
            mock_settings.TRELLO_TEMPLATE_BOARD_ID = "tb"
            mock_settings.GHL_API_KEY = "gk"
            mock_settings.GHL_PIPELINE_ID = "gp"
            mock_settings.STRIPE_SECRET_KEY = "sk"
            mock_settings.STRIPE_WEBHOOK_SECRET = "sw"
            mock_settings.DRY_RUN = True
            mock_settings.SAFE_MODE = True
            mock_settings.KILL_SWITCH = False
            mock_settings.NOTION_WRITE_LOCK = False
            mock_settings.NOTION_WRITE_ENABLED = False

            results = validator.validate_all()

        assert len(results) == 6
        subsystems = {r.subsystem for r in results}
        assert subsystems == {"notion", "trello", "ghl", "stripe", "version", "safety"}

    def test_validate_notion_no_key(self, conn):
        from packages.agencyu.boot.system_validator import SystemValidator

        validator = SystemValidator(conn)

        with patch("packages.agencyu.boot.system_validator.settings") as mock_settings:
            mock_settings.NOTION_API_KEY = ""
            result = validator._validate_notion()
        assert result.status == "warning"
        assert "not configured" in result.details

    def test_validate_trello_ok(self, conn):
        from packages.agencyu.boot.system_validator import SystemValidator

        validator = SystemValidator(conn)

        with patch("packages.agencyu.boot.system_validator.settings") as mock_settings:
            mock_settings.TRELLO_KEY = "key"
            mock_settings.TRELLO_TOKEN = "token"
            mock_settings.TRELLO_TEMPLATE_BOARD_ID = "board_id"
            result = validator._validate_trello()
        assert result.status == "ok"

    def test_validate_safety_kill_switch(self, conn):
        from packages.agencyu.boot.system_validator import SystemValidator

        validator = SystemValidator(conn)

        with patch("packages.agencyu.boot.system_validator.settings") as mock_settings:
            mock_settings.DRY_RUN = True
            mock_settings.SAFE_MODE = True
            mock_settings.KILL_SWITCH = True
            mock_settings.NOTION_WRITE_LOCK = False
            mock_settings.NOTION_WRITE_ENABLED = False
            result = validator._validate_safety_flags()
        assert result.status == "warning"
        assert "KILL_SWITCH" in result.details

    def test_persists_to_boot_validations(self, conn):
        from packages.agencyu.boot.system_validator import SystemValidator

        validator = SystemValidator(conn)

        with patch("packages.agencyu.boot.system_validator.settings") as mock_settings:
            mock_settings.NOTION_API_KEY = ""
            mock_settings.NOTION_ROOT_PAGE_ID = ""
            mock_settings.TRELLO_KEY = ""
            mock_settings.TRELLO_TOKEN = ""
            mock_settings.TRELLO_TEMPLATE_BOARD_ID = ""
            mock_settings.GHL_API_KEY = ""
            mock_settings.GHL_PIPELINE_ID = ""
            mock_settings.STRIPE_SECRET_KEY = ""
            mock_settings.STRIPE_WEBHOOK_SECRET = ""
            mock_settings.DRY_RUN = True
            mock_settings.SAFE_MODE = True
            mock_settings.KILL_SWITCH = False
            mock_settings.NOTION_WRITE_LOCK = False
            mock_settings.NOTION_WRITE_ENABLED = False

            validator.validate_all()

        rows = conn.execute("SELECT * FROM boot_validations").fetchall()
        assert len(rows) == 6

    def test_get_last_validation(self, conn):
        from packages.agencyu.boot.system_validator import SystemValidator

        validator = SystemValidator(conn)

        with patch("packages.agencyu.boot.system_validator.settings") as mock_settings:
            mock_settings.NOTION_API_KEY = ""
            mock_settings.NOTION_ROOT_PAGE_ID = ""
            mock_settings.TRELLO_KEY = "k"
            mock_settings.TRELLO_TOKEN = "t"
            mock_settings.TRELLO_TEMPLATE_BOARD_ID = "b"
            mock_settings.GHL_API_KEY = ""
            mock_settings.GHL_PIPELINE_ID = ""
            mock_settings.STRIPE_SECRET_KEY = ""
            mock_settings.STRIPE_WEBHOOK_SECRET = ""
            mock_settings.DRY_RUN = True
            mock_settings.SAFE_MODE = True
            mock_settings.KILL_SWITCH = False
            mock_settings.NOTION_WRITE_LOCK = False
            mock_settings.NOTION_WRITE_ENABLED = False

            validator.validate_all()
            last = validator.get_last_validation()

        assert len(last) == 6
        trello = next(r for r in last if r["subsystem"] == "trello")
        assert trello["status"] == "ok"
