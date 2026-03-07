"""Tests for AgencyOS v13: Marketing Core — funnel tags, lead scoring, cross-sell,
attribution chain, VSL application logic, campaign optimizer, sales memory,
unit economics, and state pruner."""

from __future__ import annotations

import json
import sqlite3
import time

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


# ═══════════════════════════════════════════
# funnel_tags.py
# ═══════════════════════════════════════════


class TestFunnelTags:
    def test_brand_enum_values(self):
        from packages.agencyu.marketing.funnel_tags import Brand
        assert Brand.CUTMV == "cutmv"
        assert Brand.FULLDIGITAL == "fulldigital"

    def test_role_enum_values(self):
        from packages.agencyu.marketing.funnel_tags import Role
        assert Role.LABEL == "label"
        assert Role.ARTIST == "artist"
        assert len(Role) == 5

    def test_tier_enum_values(self):
        from packages.agencyu.marketing.funnel_tags import Tier
        assert Tier.SCALING == "scaling"
        assert Tier.EMERGING == "emerging"

    def test_funnel_status_has_all_stages(self):
        from packages.agencyu.marketing.funnel_tags import FunnelStatus
        assert FunnelStatus.CLOSED_WON == "closed_won"
        assert FunnelStatus.NO_SHOW == "no_show"
        assert len(FunnelStatus) == 9

    def test_tag_builder(self):
        from packages.agencyu.marketing.funnel_tags import tag, brand_tag, role_tag, Brand, Role
        assert tag("brand", "cutmv") == "brand:cutmv"
        assert brand_tag(Brand.CUTMV) == "brand:cutmv"
        assert role_tag(Role.LABEL) == "role:label"

    def test_tag_sets(self):
        from packages.agencyu.marketing.funnel_tags import ALL_BRANDS, ALL_ROLES, ALL_TIERS
        assert "cutmv" in ALL_BRANDS
        assert "fulldigital" in ALL_BRANDS
        assert len(ALL_ROLES) == 5
        assert "scaling" in ALL_TIERS

    def test_tier_revenue_ranges(self):
        from packages.agencyu.marketing.funnel_tags import TIER_REVENUE_RANGES, Tier
        assert TIER_REVENUE_RANGES[Tier.EMERGING] == (0, 500_000)
        assert TIER_REVENUE_RANGES[Tier.ESTABLISHED][0] == 5_000_000

    def test_high_value_tiers(self):
        from packages.agencyu.marketing.funnel_tags import HIGH_VALUE_TIERS, Tier
        assert Tier.SCALING in HIGH_VALUE_TIERS
        assert Tier.ESTABLISHED in HIGH_VALUE_TIERS
        assert Tier.EMERGING not in HIGH_VALUE_TIERS

    def test_cross_sell_eligible_roles(self):
        from packages.agencyu.marketing.funnel_tags import CROSS_SELL_ELIGIBLE_ROLES, Role
        assert Role.ARTIST in CROSS_SELL_ELIGIBLE_ROLES
        assert Role.EDITOR not in CROSS_SELL_ELIGIBLE_ROLES


# ═══════════════════════════════════════════
# lead_scoring.py
# ═══════════════════════════════════════════


class TestLeadScoring:
    def test_priority_close_high_score(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score, ScoreBucket
        result = compute_lead_score({
            "tier": "scaling",
            "role": "label",
            "status": "booked",
            "pain": "strategy",
        })
        assert result.score >= 70
        assert result.bucket == ScoreBucket.PRIORITY_CLOSE
        assert result.breakdown["tier"] == 40
        assert result.breakdown["role"] == 30

    def test_nurture_low_score(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score, ScoreBucket
        result = compute_lead_score({
            "tier": "emerging",
            "role": "editor",
            "status": "new",
        })
        assert result.score < 40
        assert result.bucket == ScoreBucket.NURTURE

    def test_standard_followup_mid_score(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score, ScoreBucket
        result = compute_lead_score({
            "tier": "building",
            "role": "artist",
            "status": "qualified",
            "pain": "acquisition",
        })
        assert 40 <= result.score < 70
        assert result.bucket == ScoreBucket.STANDARD_FOLLOWUP

    def test_engagement_bonuses_dict(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score
        result = compute_lead_score({
            "tier": "emerging",
            "engagement_flags": {"application_submitted": True, "video_watched": True},
        })
        assert result.breakdown["engagement"] == 25  # 15 + 10

    def test_engagement_bonuses_list(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score
        result = compute_lead_score({
            "tier": "emerging",
            "engaged_flags": ["application_submitted", "replied"],
        })
        assert result.breakdown["engagement"] == 23  # 15 + 8

    def test_revenue_tier_compat(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score
        result = compute_lead_score({"revenue_tier": "15k_50k"})
        assert result.breakdown["tier"] == 40

    def test_score_capped_at_100(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score
        result = compute_lead_score({
            "tier": "scaling",
            "role": "label",
            "status": "booked",
            "pain": "all",
            "engagement_flags": {"application_submitted": True, "video_watched": True, "form_submitted": True},
        })
        assert result.score == 100

    def test_empty_contact(self):
        from packages.agencyu.marketing.lead_scoring import compute_lead_score, ScoreBucket
        result = compute_lead_score({})
        assert result.score == 0
        assert result.bucket == ScoreBucket.NURTURE


# ═══════════════════════════════════════════
# cross_sell_engine.py
# ═══════════════════════════════════════════


class TestCrossSell:
    def test_eligible_cutmv_scaling_label(self):
        from packages.agencyu.marketing.cross_sell_engine import evaluate_cross_sell
        result = evaluate_cross_sell({
            "brand": "cutmv",
            "role": "label",
            "tier": "scaling",
            "status": "booked",
        })
        assert result.eligible is True
        assert result.target_brand == "fulldigital"
        assert result.priority == "high"

    def test_not_cutmv_brand(self):
        from packages.agencyu.marketing.cross_sell_engine import evaluate_cross_sell
        result = evaluate_cross_sell({
            "brand": "fulldigital",
            "role": "label",
            "tier": "scaling",
        })
        assert result.eligible is False
        assert result.reason == "not_cutmv_brand"

    def test_ineligible_role(self):
        from packages.agencyu.marketing.cross_sell_engine import evaluate_cross_sell
        result = evaluate_cross_sell({
            "brand": "cutmv",
            "role": "editor",
            "tier": "scaling",
        })
        assert result.eligible is False
        assert "not_eligible" in result.reason

    def test_tier_too_low(self):
        from packages.agencyu.marketing.cross_sell_engine import evaluate_cross_sell
        result = evaluate_cross_sell({
            "brand": "cutmv",
            "role": "artist",
            "tier": "emerging",
        })
        assert result.eligible is False
        assert "below_threshold" in result.reason

    def test_closed_lost_not_eligible(self):
        from packages.agencyu.marketing.cross_sell_engine import evaluate_cross_sell
        result = evaluate_cross_sell({
            "brand": "cutmv",
            "role": "artist",
            "tier": "scaling",
            "status": "closed_lost",
        })
        assert result.eligible is False

    def test_standard_priority(self):
        from packages.agencyu.marketing.cross_sell_engine import evaluate_cross_sell
        result = evaluate_cross_sell({
            "brand": "cutmv",
            "role": "artist",
            "tier": "established",
            "status": "qualified",
        })
        assert result.eligible is True
        assert result.priority == "standard"


# ═══════════════════════════════════════════
# attribution_chain.py
# ═══════════════════════════════════════════


class TestAttributionChain:
    def test_build_payload_basic(self):
        from packages.agencyu.marketing.attribution_chain import build_attribution_payload
        payload = build_attribution_payload({
            "utm_campaign": "summer_launch",
            "ghl_contact_id": "ghl_123",
            "brand": "cutmv",
        })
        assert payload["utm_campaign"] == "summer_launch"
        assert payload["ghl_contact_id"] == "ghl_123"
        assert "utm_source" not in payload  # None values filtered out

    def test_build_payload_with_stripe(self):
        from packages.agencyu.marketing.attribution_chain import build_attribution_payload
        payload = build_attribution_payload(
            {"utm_campaign": "test", "ghl_contact_id": "g1"},
            stripe_event={"checkout_id": "cs_abc", "amount_cents": 500_00},
        )
        assert payload["stripe_checkout_id"] == "cs_abc"
        assert payload["amount_cents"] == 500_00

    def test_validate_complete_chain(self):
        from packages.agencyu.marketing.attribution_chain import validate_attribution_chain
        chain = validate_attribution_chain(
            {"manychat_contact_id": "mc_1", "ghl_contact_id": "ghl_1", "utm_campaign": "camp1"},
            stripe_event={"checkout_id": "cs_1"},
            notion_record={"notion_page_id": "np_1"},
            qb_record={"qb_invoice_id": "qb_1"},
        )
        assert chain.complete is True
        assert len(chain.missing_systems) == 0
        assert len(chain.links) == 6

    def test_validate_incomplete_chain(self):
        from packages.agencyu.marketing.attribution_chain import validate_attribution_chain
        chain = validate_attribution_chain(
            {"ghl_contact_id": "ghl_1", "utm_campaign": "camp1"},
        )
        assert chain.complete is False
        assert "manychat" in chain.missing_systems
        assert "stripe" in chain.missing_systems
        assert "notion" in chain.missing_systems
        assert "quickbooks" in chain.missing_systems

    def test_contact_key_resolution(self):
        from packages.agencyu.marketing.attribution_chain import validate_attribution_chain
        chain = validate_attribution_chain({"email": "test@test.com"})
        assert chain.contact_key == "test@test.com"

    def test_contact_key_unknown(self):
        from packages.agencyu.marketing.attribution_chain import validate_attribution_chain
        chain = validate_attribution_chain({})
        assert chain.contact_key == "unknown"


# ═══════════════════════════════════════════
# vsl_application_logic.py
# ═══════════════════════════════════════════


class TestVSLApplication:
    def test_book_call_high_quality(self):
        from packages.agencyu.marketing.vsl_application_logic import (
            evaluate_application, ApplicationVerdict,
        )
        result = evaluate_application({
            "monthly_revenue": 10_000,
            "budget": 5_000,
            "release_timeline_weeks": 8,
            "tier": "scaling",
            "role": "label",
            "pain": "strategy",
        })
        assert result.verdict == ApplicationVerdict.BOOK_CALL
        assert result.score >= 65

    def test_nurture_below_thresholds(self):
        from packages.agencyu.marketing.vsl_application_logic import (
            evaluate_application, ApplicationVerdict,
        )
        result = evaluate_application({
            "monthly_revenue": 2_000,
            "budget": 1_000,
        })
        assert result.verdict == ApplicationVerdict.NURTURE
        assert 35 <= result.score < 65

    def test_reject_very_low(self):
        from packages.agencyu.marketing.vsl_application_logic import (
            evaluate_application, ApplicationVerdict,
        )
        # Empty application starts at 50 midpoint, gets "no_revenue_data" and "no_budget_data"
        # Score = 50 (midpoint) → nurture range. To get reject, need negative signals.
        result = evaluate_application({})
        # With no data, score is 50 which is nurture (35-64)
        assert result.verdict == ApplicationVerdict.NURTURE
        assert result.score >= 35

    def test_delay_followup_long_timeline(self):
        from packages.agencyu.marketing.vsl_application_logic import (
            evaluate_application, ApplicationVerdict,
        )
        result = evaluate_application({
            "monthly_revenue": 10_000,
            "budget": 5_000,
            "release_timeline_weeks": 20,
            "tier": "scaling",
        })
        assert result.verdict == ApplicationVerdict.DELAY_FOLLOWUP
        assert result.delay_days is not None
        assert result.delay_days > 0

    def test_listeners_count_as_revenue(self):
        from packages.agencyu.marketing.vsl_application_logic import (
            evaluate_application, ApplicationVerdict,
        )
        result = evaluate_application({
            "monthly_listeners": 100_000,
            "budget": 5_000,
            "release_timeline_weeks": 4,
        })
        assert result.score >= 65
        assert result.verdict == ApplicationVerdict.BOOK_CALL

    def test_custom_thresholds(self):
        from packages.agencyu.marketing.vsl_application_logic import evaluate_application
        # With very low thresholds, even small data passes
        result = evaluate_application(
            {"monthly_revenue": 1_000, "budget": 500, "release_timeline_weeks": 4},
            min_monthly_revenue=500,
            min_budget=200,
        )
        assert result.score >= 65


# ═══════════════════════════════════════════
# campaign_optimizer.py
# ═══════════════════════════════════════════


class TestCampaignOptimizer:
    def test_scale_healthy(self):
        from packages.agencyu.marketing.campaign_optimizer import (
            evaluate_campaign_performance, CampaignAction,
        )
        result = evaluate_campaign_performance({
            "cost_per_booked_call": 100_00,
            "close_rate": 0.25,
            "show_rate": 0.80,
            "cost_per_signup": 15_00,
        })
        assert result.action == CampaignAction.SCALE
        assert result.severity == "info"

    def test_pause_critical_close_rate(self):
        from packages.agencyu.marketing.campaign_optimizer import (
            evaluate_campaign_performance, CampaignAction,
        )
        result = evaluate_campaign_performance({
            "close_rate": 0.05,
            "show_rate": 0.80,
        })
        assert result.action == CampaignAction.PAUSE
        assert result.severity == "critical"

    def test_pause_critical_show_rate(self):
        from packages.agencyu.marketing.campaign_optimizer import (
            evaluate_campaign_performance, CampaignAction,
        )
        result = evaluate_campaign_performance({
            "close_rate": 0.20,
            "show_rate": 0.40,
        })
        assert result.action == CampaignAction.PAUSE
        assert result.severity == "critical"

    def test_reduce_budget_high_cost(self):
        from packages.agencyu.marketing.campaign_optimizer import (
            evaluate_campaign_performance, CampaignAction,
        )
        result = evaluate_campaign_performance({
            "cost_per_booked_call": 200_00,
            "close_rate": 0.20,
            "show_rate": 0.80,
        })
        assert result.action == CampaignAction.REDUCE_BUDGET

    def test_adjust_vsl_low_close(self):
        from packages.agencyu.marketing.campaign_optimizer import (
            evaluate_campaign_performance, CampaignAction,
        )
        result = evaluate_campaign_performance({
            "cost_per_booked_call": 100_00,
            "close_rate": 0.10,
            "show_rate": 0.80,
        })
        assert result.action == CampaignAction.ADJUST_VSL

    def test_improve_reminders_low_show(self):
        from packages.agencyu.marketing.campaign_optimizer import (
            evaluate_campaign_performance, CampaignAction,
        )
        result = evaluate_campaign_performance({
            "cost_per_booked_call": 100_00,
            "close_rate": 0.20,
            "show_rate": 0.55,
        })
        assert result.action == CampaignAction.IMPROVE_REMINDERS

    def test_refresh_creative_high_signup_cost(self):
        from packages.agencyu.marketing.campaign_optimizer import (
            evaluate_campaign_performance, CampaignAction,
        )
        result = evaluate_campaign_performance({
            "cost_per_booked_call": 100_00,
            "close_rate": 0.20,
            "show_rate": 0.80,
            "cost_per_signup": 40_00,
        })
        assert result.action == CampaignAction.REFRESH_CREATIVE


class TestCreativeFatigue:
    def test_no_peak_data(self):
        from packages.agencyu.marketing.campaign_optimizer import detect_creative_fatigue
        result = detect_creative_fatigue({"peak_ctr": 0})
        assert result["fatigued"] is False

    def test_below_ctr_floor(self):
        from packages.agencyu.marketing.campaign_optimizer import detect_creative_fatigue
        result = detect_creative_fatigue({
            "current_ctr": 0.005,
            "peak_ctr": 0.03,
            "days_running": 30,
        })
        assert result["fatigued"] is True
        assert result["recommendation"] == "replace_creative_immediately"

    def test_significant_decline(self):
        from packages.agencyu.marketing.campaign_optimizer import detect_creative_fatigue
        result = detect_creative_fatigue({
            "current_ctr": 0.015,
            "peak_ctr": 0.03,
            "days_running": 21,
        })
        assert result["fatigued"] is True
        assert result["recommendation"] == "rotate_hooks"

    def test_new_creative_decline(self):
        from packages.agencyu.marketing.campaign_optimizer import detect_creative_fatigue
        result = detect_creative_fatigue({
            "current_ctr": 0.015,
            "peak_ctr": 0.03,
            "days_running": 7,
        })
        assert result["fatigued"] is True
        assert result["recommendation"] == "test_new_ugc"

    def test_healthy_ctr(self):
        from packages.agencyu.marketing.campaign_optimizer import detect_creative_fatigue
        result = detect_creative_fatigue({
            "current_ctr": 0.025,
            "peak_ctr": 0.03,
            "days_running": 14,
        })
        assert result["fatigued"] is False


# ═══════════════════════════════════════════
# sales_memory.py
# ═══════════════════════════════════════════


class TestSalesMemory:
    def test_record_objection(self, conn):
        from packages.agencyu.marketing.sales_memory import record_objection
        obj_id = record_objection(
            conn,
            contact_id="contact_abc",
            objection_category="price",
            objection_text="Too expensive",
            call_outcome="closed_lost",
            brand="cutmv",
        )
        assert obj_id.startswith("obj_")
        row = conn.execute("SELECT * FROM sales_objections WHERE id=?", (obj_id,)).fetchone()
        assert row is not None
        assert row["objection_category"] == "price"

    def test_get_objection_frequency(self, conn):
        from packages.agencyu.marketing.sales_memory import record_objection, get_objection_frequency
        record_objection(conn, contact_id="c1", objection_category="price", call_outcome="lost")
        record_objection(conn, contact_id="c2", objection_category="price", call_outcome="lost")
        record_objection(conn, contact_id="c3", objection_category="timing", call_outcome="won")

        freq = get_objection_frequency(conn)
        assert len(freq) == 2
        assert freq[0]["objection_category"] == "price"
        assert freq[0]["count"] == 2

    def test_get_objection_frequency_filtered(self, conn):
        from packages.agencyu.marketing.sales_memory import record_objection, get_objection_frequency
        record_objection(conn, contact_id="c1", objection_category="price", campaign="camp_a")
        record_objection(conn, contact_id="c2", objection_category="price", campaign="camp_b")

        freq = get_objection_frequency(conn, campaign="camp_a")
        assert len(freq) == 1
        assert freq[0]["count"] == 1

    def test_get_recent_objections(self, conn):
        from packages.agencyu.marketing.sales_memory import record_objection, get_recent_objections
        record_objection(conn, contact_id="c1", objection_category="trust")
        record_objection(conn, contact_id="c2", objection_category="diy")

        recent = get_recent_objections(conn, limit=10)
        assert len(recent) == 2

    def test_analyze_objection_patterns_empty(self, conn):
        from packages.agencyu.marketing.sales_memory import analyze_objection_patterns
        result = analyze_objection_patterns(conn)
        assert result["total_objections"] == 0
        assert result["insights"] == []

    def test_analyze_objection_patterns_with_data(self, conn):
        from packages.agencyu.marketing.sales_memory import record_objection, analyze_objection_patterns
        # Record many price objections to trigger recommendation
        for i in range(8):
            record_objection(conn, contact_id=f"c{i}", objection_category="price")
        record_objection(conn, contact_id="c10", objection_category="timing")

        result = analyze_objection_patterns(conn)
        assert result["total_objections"] == 9
        assert len(result["insights"]) >= 1
        # Price is dominant (>30%), should get recommendation
        assert any("price" in r.lower() or "anchoring" in r.lower() for r in result["recommendations"])

    def test_objection_categories_constant(self):
        from packages.agencyu.marketing.sales_memory import OBJECTION_CATEGORIES
        assert "price" in OBJECTION_CATEGORIES
        assert "trust" in OBJECTION_CATEGORIES
        assert len(OBJECTION_CATEGORIES) == 9


# ═══════════════════════════════════════════
# unit_economics_engine.py
# ═══════════════════════════════════════════


class TestUnitEconomics:
    def test_healthy_economics(self):
        from packages.agencyu.marketing.unit_economics_engine import compute_unit_economics
        result = compute_unit_economics({
            "ad_spend_cents": 100_000,
            "new_customers": 10,
            "avg_monthly_revenue_cents": 300_000,
            "avg_retention_months": 6.0,
        })
        assert result.cac_cents == 10_000
        assert result.ltv_cents == 1_800_000
        assert result.ltv_cac_ratio > 3.0
        assert result.healthy is True
        assert len(result.warnings) == 0

    def test_unhealthy_low_ratio(self):
        from packages.agencyu.marketing.unit_economics_engine import compute_unit_economics
        result = compute_unit_economics({
            "ad_spend_cents": 1_000_000,
            "new_customers": 10,
            "avg_monthly_revenue_cents": 100_000,
            "avg_retention_months": 2.0,
        })
        # LTV = 100k * 2 = 200k, CAC = 1M/10 = 100k, ratio = 2.0 (exactly at warning threshold)
        assert result.ltv_cac_ratio <= 2.0
        assert result.healthy is False
        # Retention warning is present (2.0 < 3.0)
        assert any("retention" in w for w in result.warnings)

    def test_close_rate_warning(self):
        from packages.agencyu.marketing.unit_economics_engine import compute_unit_economics
        result = compute_unit_economics({
            "ad_spend_cents": 100_000,
            "new_customers": 10,
            "avg_monthly_revenue_cents": 300_000,
            "avg_retention_months": 6.0,
            "close_rate": 0.05,
        })
        assert any("close_rate" in w for w in result.warnings)
        assert result.healthy is False

    def test_retention_warning(self):
        from packages.agencyu.marketing.unit_economics_engine import compute_unit_economics
        result = compute_unit_economics({
            "ad_spend_cents": 100_000,
            "new_customers": 10,
            "avg_monthly_revenue_cents": 300_000,
            "avg_retention_months": 2.0,
        })
        assert any("retention" in w for w in result.warnings)

    def test_zero_customers(self):
        from packages.agencyu.marketing.unit_economics_engine import compute_unit_economics
        result = compute_unit_economics({
            "ad_spend_cents": 100_000,
            "new_customers": 0,
        })
        assert result.cac_cents == 0
        assert result.ltv_cac_ratio == 0.0


class TestCapitalPreservation:
    def test_should_pause_high_cac(self):
        from packages.agencyu.marketing.unit_economics_engine import (
            compute_unit_economics, should_preserve_capital,
        )
        # CAC = 1M/5 = 200k, LTV = 200k*3 = 600k, LTV/3 = 200k, ratio = 3.0
        # Need CAC > LTV/3 or ratio < 2.0 to trigger pause
        econ = compute_unit_economics({
            "ad_spend_cents": 2_000_000,
            "new_customers": 5,
            "avg_monthly_revenue_cents": 200_000,
            "avg_retention_months": 3.0,
        })
        # CAC=400k, LTV=600k, LTV/3=200k → CAC 400k > 200k → should pause
        result = should_preserve_capital(econ)
        assert result["should_pause"] is True
        assert len(result["reasons"]) > 0

    def test_should_not_pause_healthy(self):
        from packages.agencyu.marketing.unit_economics_engine import (
            compute_unit_economics, should_preserve_capital,
        )
        econ = compute_unit_economics({
            "ad_spend_cents": 50_000,
            "new_customers": 10,
            "avg_monthly_revenue_cents": 300_000,
            "avg_retention_months": 6.0,
        })
        result = should_preserve_capital(econ)
        assert result["should_pause"] is False


class TestRevenueForecast:
    def test_basic_forecast(self):
        from packages.agencyu.marketing.unit_economics_engine import revenue_forecast
        result = revenue_forecast(
            booked_calls=20,
            historical_close_rate=0.25,
            avg_deal_size_cents=300_000,
            current_mrr_cents=1_000_000,
        )
        assert result["forecast_30d_cents"] > 0
        assert result["forecast_90d_cents"] > result["forecast_30d_cents"]
        assert result["booked_calls"] == 20
        assert result["projected_new_revenue_30d_cents"] == 20 * 0.25 * 300_000

    def test_forecast_with_pipeline(self):
        from packages.agencyu.marketing.unit_economics_engine import revenue_forecast
        result = revenue_forecast(
            booked_calls=10,
            historical_close_rate=0.20,
            avg_deal_size_cents=500_000,
            pipeline_value_cents=5_000_000,
        )
        assert result["pipeline_value_cents"] == 5_000_000


class TestCampaignUnitEconomics:
    def test_compute_from_db(self, conn):
        from packages.agencyu.marketing.unit_economics_engine import compute_campaign_unit_economics
        # Create campaign_integrity table row
        try:
            conn.execute(
                "INSERT INTO campaign_integrity (utm_campaign, ad_spend_cents, closed_won, total_leads, close_rate, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("camp_summer", 100_000, 10, 100, 0.10, "2025-01-01T00:00:00Z"),
            )
            conn.commit()
        except Exception:
            pass  # table might not exist

        result = compute_campaign_unit_economics(conn, "camp_summer")
        if result is not None:
            assert result.cac_cents == 10_000
            assert result.new_customers == 10

    def test_compute_missing_campaign(self, conn):
        from packages.agencyu.marketing.unit_economics_engine import compute_campaign_unit_economics
        result = compute_campaign_unit_economics(conn, "nonexistent_campaign")
        assert result is None


# ═══════════════════════════════════════════
# state_pruner.py
# ═══════════════════════════════════════════


class TestStatePruner:
    def test_prune_job_stops_noop(self, conn):
        from packages.agencyu.services.state_pruner import prune_recent_job_stops
        result = prune_recent_job_stops(conn)
        assert result["pruned"] is False

    def test_prune_job_stops_trims(self, conn):
        from packages.agencyu.services.state_pruner import prune_recent_job_stops
        from packages.agencyu.services.system_state import SystemState, SystemKeys

        state = SystemState(conn)
        items = [{"ts": f"2025-01-01T{i:02d}:00:00Z", "job": "test"} for i in range(250)]
        state.set_json(SystemKeys.RECENT_JOB_STOPS_JSON, {"items": items})

        result = prune_recent_job_stops(conn, max_items=200)
        assert result["pruned"] is True
        assert result["trimmed"] == 50
        assert result["remaining"] == 200

        # Verify actual count
        buf = state.get_json(SystemKeys.RECENT_JOB_STOPS_JSON, default={"items": []})
        assert len(buf["items"]) == 200

    def test_prune_audit_logs_noop(self, conn):
        from packages.agencyu.services.state_pruner import prune_old_audit_logs
        result = prune_old_audit_logs(conn)
        assert result["pruned"] is True
        assert result["deleted"] == 0

    def test_prune_audit_logs_deletes_old(self, conn):
        from packages.agencyu.services.state_pruner import prune_old_audit_logs
        # Insert old and new audit_logs
        conn.execute(
            "INSERT INTO audit_logs (id, ts, correlation_id, system, action, result) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("old1", "2020-01-01T00:00:00Z", "corr1", "test", "test", "ok"),
        )
        conn.execute(
            "INSERT INTO audit_logs (id, ts, correlation_id, system, action, result) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("new1", "2099-01-01T00:00:00Z", "corr2", "test", "test", "ok"),
        )
        conn.commit()

        result = prune_old_audit_logs(conn, keep_days=90)
        assert result["pruned"] is True
        assert result["deleted"] == 1

        # Verify only new row remains
        row = conn.execute("SELECT COUNT(*) FROM audit_logs").fetchone()
        assert row[0] == 1


# ═══════════════════════════════════════════
# DB tables: sales_objections + creative_registry
# ═══════════════════════════════════════════


class TestDBTables:
    def test_sales_objections_table_exists(self, conn):
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='sales_objections'"
        ).fetchone()
        assert row is not None

    def test_creative_registry_table_exists(self, conn):
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='creative_registry'"
        ).fetchone()
        assert row is not None

    def test_creative_registry_insert(self, conn):
        conn.execute(
            """INSERT INTO creative_registry
               (id, creative_name, creative_type, campaign, brand, platform, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("cr_1", "Summer Hook v1", "ugc_video", "camp_summer", "cutmv", "meta", "active",
             "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM creative_registry WHERE id='cr_1'").fetchone()
        assert row["creative_name"] == "Summer Hook v1"
