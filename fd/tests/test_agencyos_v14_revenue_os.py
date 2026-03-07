"""Tests for AgencyOS v14: Revenue OS — engines, trackers, integrations, glue layer, brain."""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest

from packages.common.db import init_schema


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    return c


# ═══════════════════════════════════════════
# engines/meta_ads.py
# ═══════════════════════════════════════════


class TestMetaAdsManager:
    def test_create_campaign(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        camp = mgr.create_campaign("cutmv")
        assert camp["brand"] == "cutmv"
        assert camp["id"].startswith("camp_cutmv_")
        assert camp["status"] == "PAUSED"

    def test_create_ad_set(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        ad_set = mgr.create_ad_set("camp_1", "cutmv", "aud_01", 25.0)
        assert ad_set["audience_id"] == "aud_01"
        assert ad_set["daily_budget"] == 25.0

    def test_create_ad_tracks_performance(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        ad = mgr.create_ad("adset_1", "cutmv", "v1", combo_id="combo_abc")
        assert ad["combo_id"] == "combo_abc"
        assert ad["id"] in mgr.performances
        assert mgr.performances[ad["id"]].combo_id == "combo_abc"

    def test_create_ab_test(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        test = mgr.create_ab_test("cutmv", ["v1", "v2"], "aud_01", 17.0)
        assert len(test["variants"]) == 2
        assert test["total_daily_budget"] == 34.0

    def test_ab_test_with_cta_variants(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        test = mgr.create_ab_test("cutmv", ["v1"], "aud_01", 10.0, cta_variants=["cta_a", "cta_b"])
        assert len(test["variants"]) == 2  # 1 creative × 2 CTAs

    def test_evaluate_performance_wait(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager, AdPerformance, AdStatus
        mgr = MetaAdsManager()
        mgr.performances["ad_1"] = AdPerformance(ad_id="ad_1", variant_id="v1", brand="cutmv", spend=10, status=AdStatus.ACTIVE)
        assert mgr.evaluate_performance("ad_1") == "wait"

    def test_evaluate_performance_kill_high_cpa(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager, AdPerformance, AdStatus
        mgr = MetaAdsManager()
        mgr.performances["ad_1"] = AdPerformance(
            ad_id="ad_1", variant_id="v1", brand="cutmv",
            spend=100, days_running=5, conversions=1, impressions=5000, clicks=50,
            status=AdStatus.ACTIVE,
        )
        assert mgr.evaluate_performance("ad_1") == "kill"

    def test_evaluate_performance_scale(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager, AdPerformance, AdStatus
        mgr = MetaAdsManager()
        mgr.performances["ad_1"] = AdPerformance(
            ad_id="ad_1", variant_id="v1", brand="cutmv",
            spend=100, days_running=5, conversions=10, revenue=500,
            impressions=10000, clicks=200, status=AdStatus.ACTIVE,
        )
        assert mgr.evaluate_performance("ad_1") == "scale"

    def test_launch_phase_1_cutmv(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        test = mgr.launch_phase_1_cutmv()
        assert len(test["variants"]) == 3

    def test_launch_phase_1_fulldigital(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        test = mgr.launch_phase_1_fulldigital()
        assert len(test["variants"]) == 1

    def test_launch_ab_matrix_dry_run(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()

        class FakeCombo:
            combo_id = "combo_1"
            creative_id = "cr_1"
            cta_id = "cta_1"
            audience_id = "aud_1"

        result = mgr.launch_ab_matrix([FakeCombo()], "cutmv", dry_run=True)
        assert result["dry_run"] is True
        assert result["combos_launched"] == 1
        assert "ad_id" not in result["results"][0]

    def test_launch_ab_matrix_live(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()

        class FakeCombo:
            combo_id = "combo_1"
            creative_id = "cr_1"
            cta_id = "cta_1"
            audience_id = "aud_1"

        result = mgr.launch_ab_matrix([FakeCombo()], "cutmv", dry_run=False)
        assert result["dry_run"] is False
        assert "ad_id" in result["results"][0]

    def test_detect_creative_fatigue(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager, AdPerformance
        mgr = MetaAdsManager()
        history = [
            AdPerformance(ad_id="a", variant_id="v", brand="cutmv", ctr=3.0),
            AdPerformance(ad_id="a", variant_id="v", brand="cutmv", ctr=2.5),
            AdPerformance(ad_id="a", variant_id="v", brand="cutmv", ctr=2.0),
            AdPerformance(ad_id="a", variant_id="v", brand="cutmv", ctr=1.5),
        ]
        assert mgr.detect_creative_fatigue("a", history) is True

    def test_no_fatigue_short_history(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager, AdPerformance
        mgr = MetaAdsManager()
        history = [AdPerformance(ad_id="a", variant_id="v", brand="cutmv", ctr=3.0)]
        assert mgr.detect_creative_fatigue("a", history) is False

    def test_daily_report(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        mgr = MetaAdsManager()
        report = mgr.generate_daily_report()
        assert "cutmv" in report["brands"]
        assert "fulldigital" in report["brands"]


# ═══════════════════════════════════════════
# engines/ltv_retention.py
# ═══════════════════════════════════════════


class TestLTVRetention:
    def _make_customer(self, **kwargs):
        from packages.agencyu.engines.ltv_retention import Customer
        defaults = {
            "id": "c1", "brand": "cutmv", "name": "Test", "email": "t@t.com",
            "plan": "pro", "mrr": 49, "start_date": date.today() - timedelta(days=60),
            "total_revenue": 98, "months_active": 2,
        }
        defaults.update(kwargs)
        return Customer(**defaults)

    def test_calculate_ltv_cutmv(self):
        from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
        engine = LTVRetentionEngine()
        c = self._make_customer()
        engine.add_customer(c)
        ltv = engine.calculate_ltv("c1")
        assert ltv["actual_ltv"] == 98
        assert ltv["projected_ltv"] > 98
        assert ltv["risk_adjusted_ltv"] > 0

    def test_calculate_ltv_fulldigital(self):
        from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
        engine = LTVRetentionEngine()
        c = self._make_customer(id="fd1", brand="fulldigital", mrr=5000, total_revenue=10000, months_active=2)
        engine.add_customer(c)
        ltv = engine.calculate_ltv("fd1")
        assert ltv["projected_ltv"] > ltv["actual_ltv"]

    def test_predict_churn_low_risk(self):
        from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
        engine = LTVRetentionEngine()
        c = self._make_customer(last_login=date.today(), nps_score=9)
        engine.add_customer(c)
        risk = engine.predict_churn_risk("c1")
        assert risk["risk_level"] == "low"

    def test_predict_churn_high_risk_cutmv(self):
        from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
        engine = LTVRetentionEngine()
        c = self._make_customer(
            last_login=date.today() - timedelta(days=21),
            last_upload=date.today() - timedelta(days=30),
            nps_score=3, support_tickets_30d=5,
        )
        engine.add_customer(c)
        risk = engine.predict_churn_risk("c1")
        assert risk["risk_score"] >= 50
        assert risk["risk_level"] in ("high", "critical")
        assert len(risk["signals"]) > 0
        assert len(risk["recommended_actions"]) > 0

    def test_expansion_opportunities(self):
        from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
        engine = LTVRetentionEngine()
        c = self._make_customer(plan="starter", videos_processed_30d=10, nps_score=9)
        engine.add_customer(c)
        opps = engine.identify_expansion_opportunities()
        assert len(opps) >= 1
        assert any(o["type"] == "plan_upgrade" for o in opps)

    def test_max_cac(self):
        from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
        engine = LTVRetentionEngine()
        for i in range(5):
            c = self._make_customer(id=f"c{i}", mrr=49, total_revenue=200, months_active=4)
            engine.add_customer(c)
        result = engine.calculate_max_cac("cutmv")
        assert result["recommended_max_cac"] > 0
        assert result["active_customers"] == 5

    def test_max_cac_no_customers(self):
        from packages.agencyu.engines.ltv_retention import LTVRetentionEngine
        engine = LTVRetentionEngine()
        result = engine.calculate_max_cac("cutmv")
        assert result["recommended_max_cac"] == 0


# ═══════════════════════════════════════════
# engines/revenue_forecast.py
# ═══════════════════════════════════════════


class TestRevenueForecast:
    def test_run_forecast_cutmv(self):
        from packages.agencyu.engines.revenue_forecast import RevenueForecastEngine, FunnelMetrics
        engine = RevenueForecastEngine(simulations=50)
        metrics = FunnelMetrics(brand="cutmv", daily_ad_spend=50)
        result = engine.run_forecast(metrics, period_days=30)
        assert result.brand == "cutmv"
        assert result.period_days == 30
        assert result.total_spend == 1500.0
        assert result.confidence_interval[0] <= result.total_revenue <= result.confidence_interval[1]

    def test_run_forecast_fulldigital(self):
        from packages.agencyu.engines.revenue_forecast import RevenueForecastEngine, FunnelMetrics
        engine = RevenueForecastEngine(simulations=50)
        metrics = FunnelMetrics(brand="fulldigital", daily_ad_spend=30)
        result = engine.run_forecast(metrics, period_days=30)
        assert result.brand == "fulldigital"

    def test_run_scenarios(self):
        from packages.agencyu.engines.revenue_forecast import RevenueForecastEngine
        engine = RevenueForecastEngine(simulations=50)
        scenarios = engine.run_scenarios("cutmv", period_days=30)
        assert "conservative" in scenarios
        assert "moderate" in scenarios
        assert "aggressive" in scenarios
        assert scenarios["aggressive"].total_spend >= scenarios["conservative"].total_spend


# ═══════════════════════════════════════════
# trackers/setter_performance.py
# ═══════════════════════════════════════════


class TestSetterPerformance:
    def _make_setter_with_data(self):
        from packages.agencyu.trackers.setter_performance import (
            Setter, DailySetterMetrics, SetterPerformanceTracker,
        )
        tracker = SetterPerformanceTracker()
        setter = Setter(id="s1", name="Alex", brand="fulldigital")

        for i in range(7):
            d = date.today() - timedelta(days=6 - i)
            metrics = DailySetterMetrics(
                setter_id="s1", date=d, brand="fulldigital",
                dms_sent=30, conversations_started=15,
                leads_qualified=5, appointments_booked=3,
                appointments_showed=2, deals_closed=1,
                revenue_attributed=5000, avg_response_time_minutes=4.0,
                eod_form_submitted=True,
            )
            setter.add_daily_metrics(metrics)

        tracker.add_setter(setter)
        return tracker

    def test_score_setter(self):
        tracker = self._make_setter_with_data()
        score = tracker.score_setter("s1", period_days=7)
        assert score["overall_score"] > 0
        assert score["grade"] in ("A", "B", "C", "D", "F")
        assert "component_scores" in score

    def test_score_setter_not_found(self):
        from packages.agencyu.trackers.setter_performance import SetterPerformanceTracker
        tracker = SetterPerformanceTracker()
        result = tracker.score_setter("nonexistent")
        assert "error" in result

    def test_leaderboard(self):
        tracker = self._make_setter_with_data()
        lb = tracker.generate_leaderboard(period_days=7)
        assert len(lb) == 1
        assert lb[0]["rank"] == 1

    def test_check_alerts_zero_bookings(self):
        from packages.agencyu.trackers.setter_performance import (
            Setter, DailySetterMetrics, SetterPerformanceTracker,
        )
        tracker = SetterPerformanceTracker()
        setter = Setter(id="s2", name="Bob", brand="cutmv")
        for i in range(3):
            d = date.today() - timedelta(days=2 - i)
            setter.add_daily_metrics(DailySetterMetrics(
                setter_id="s2", date=d, brand="cutmv",
                dms_sent=10, appointments_booked=0,
            ))
        tracker.add_setter(setter)
        alerts = tracker.check_alerts()
        assert any(a["type"] == "zero_bookings" for a in alerts)

    def test_daily_metrics_properties(self):
        from packages.agencyu.trackers.setter_performance import DailySetterMetrics
        m = DailySetterMetrics(
            setter_id="s1", date=date.today(), brand="cutmv",
            conversations_started=20, appointments_booked=4,
            appointments_showed=3, appointments_no_show=1,
            deals_closed=1, leads_qualified=8, leads_disqualified=2,
        )
        assert m.book_rate == 20.0
        assert m.show_rate == 75.0
        assert m.close_rate == pytest.approx(33.3, abs=0.1)
        assert m.qualification_rate == 80.0


# ═══════════════════════════════════════════
# integrations/clickfunnels_vsl.py
# ═══════════════════════════════════════════


class TestClickFunnelsVSL:
    def test_create_cutmv_funnel(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        assert funnel["brand"] == "cutmv"
        assert "opt_in" in funnel["pages"]
        assert "vsl" in funnel["pages"]
        assert "checkout" in funnel["pages"]
        assert "thank_you" in funnel["pages"]

    def test_create_fulldigital_funnel(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_fulldigital_funnel()
        assert funnel["brand"] == "fulldigital"
        assert "application" in funnel["pages"]
        assert "booking" in funnel["pages"]

    def test_visitor_tracking(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager, VisitorStage
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        visitor = mgr.track_visitor(
            funnel["id"],
            utm_params={"utm_source": "instagram", "utm_campaign": "test"},
            combo_id="combo_abc",
        )
        assert visitor.utm_source == "instagram"
        assert visitor.combo_id == "combo_abc"
        assert VisitorStage.LANDED in visitor.stages_completed

    def test_opt_in_and_vsl_progress(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager, VisitorStage
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        visitor = mgr.track_visitor(funnel["id"])
        mgr.record_opt_in(visitor.visitor_id, "test@test.com", "Test")
        assert visitor.email == "test@test.com"
        assert VisitorStage.OPTED_IN in visitor.stages_completed

        mgr.record_vsl_progress(visitor.visitor_id, 50, 120)
        assert visitor.vsl_watch_percent == 50
        assert VisitorStage.VSL_50 in visitor.stages_completed

        mgr.record_vsl_progress(visitor.visitor_id, 100, 240)
        assert VisitorStage.VSL_COMPLETE in visitor.stages_completed

    def test_application_and_booking(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager, VisitorStage
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_fulldigital_funnel()
        visitor = mgr.track_visitor(funnel["id"])
        mgr.record_opt_in(visitor.visitor_id, "artist@test.com")
        mgr.record_application(visitor.visitor_id, {
            "role": "artist", "monthly_listeners": "50K+",
            "generating_revenue": "yes", "investment_ready": "yes",
        })
        assert VisitorStage.APPLICATION_SUBMITTED in visitor.stages_completed

        mgr.record_booking(visitor.visitor_id, datetime.now() + timedelta(days=2))
        assert visitor.booked_call is True

    def test_payment_recording(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        visitor = mgr.track_visitor(funnel["id"])
        mgr.record_opt_in(visitor.visitor_id, "buyer@test.com")
        mgr.record_payment(visitor.visitor_id, 49.0)
        assert visitor.paid is True
        assert visitor.deal_value == 49.0

    def test_full_attribution(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        visitor = mgr.track_visitor(
            funnel["id"],
            utm_params={"utm_source": "ig", "utm_campaign": "camp1", "creative": "cr1"},
            combo_id="combo_xyz",
        )
        attr = visitor.full_attribution
        assert attr["source"] == "ig"
        assert attr["campaign"] == "camp1"
        assert attr["combo_id"] == "combo_xyz"

    def test_stripe_webhook(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        visitor = mgr.track_visitor(funnel["id"])
        mgr.record_opt_in(visitor.visitor_id, "pay@test.com")

        result = mgr.handle_stripe_webhook({
            "type": "checkout.session.completed",
            "data": {"object": {"customer_email": "pay@test.com", "amount_total": 4900}},
        })
        assert result["status"] == "processed"
        assert visitor.paid is True

    def test_calendly_webhook(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_fulldigital_funnel()
        visitor = mgr.track_visitor(funnel["id"])
        mgr.record_opt_in(visitor.visitor_id, "book@test.com")

        result = mgr.handle_calendly_webhook({
            "event": "invitee.created",
            "payload": {
                "email": "book@test.com",
                "scheduled_event": {"start_time": "2026-03-10T14:00:00Z"},
            },
        })
        assert result["status"] == "processed"
        assert visitor.booked_call is True

    def test_page_variant(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        optin_page = funnel["pages"]["opt_in"]
        variant = mgr.create_page_variant(optin_page.id, "test_v1", {"headline": "New Headline"})
        assert variant.headline == "New Headline"
        assert variant.variant_id == "test_v1"

    def test_funnel_analytics_no_data(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        funnel = mgr.create_cutmv_funnel()
        analytics = mgr.get_funnel_analytics(funnel["id"])
        assert analytics["no_data"] is True

    def test_application_scoring(self):
        from packages.agencyu.integrations.clickfunnels_vsl import ClickFunnelsVSLManager
        mgr = ClickFunnelsVSLManager()
        score = mgr._score_application({
            "monthly_listeners": "100K+", "generating_revenue": "yes",
            "investment_ready": "yes", "role": "label", "releases_last_12mo": "6",
        })
        assert score >= 80


# ═══════════════════════════════════════════
# marketing/playbook_registry.py
# ═══════════════════════════════════════════


class TestPlaybookRegistry:
    def test_register_and_get(self):
        from packages.agencyu.marketing.playbook_registry import PlaybookRegistry, FunnelModule
        reg = PlaybookRegistry()
        mod = FunnelModule(
            module_id="test_acq", brand="cutmv", kind="acquisition",
            description="Test acquisition", stages_emitted=["ad_impression"],
        )
        reg.register(mod)
        assert reg.get("test_acq") == mod
        assert reg.count() == 1

    def test_duplicate_raises(self):
        from packages.agencyu.marketing.playbook_registry import PlaybookRegistry, FunnelModule
        reg = PlaybookRegistry()
        mod = FunnelModule(module_id="dup", brand="cutmv", kind="acquisition",
                           description="Test", stages_emitted=[])
        reg.register(mod)
        with pytest.raises(ValueError, match="Duplicate"):
            reg.register(mod)

    def test_list_by_brand(self):
        from packages.agencyu.marketing.playbook_registry import PlaybookRegistry, seed_default_modules
        reg = PlaybookRegistry()
        seed_default_modules(reg)
        cutmv = reg.list_modules(brand="cutmv")
        fd = reg.list_modules(brand="fulldigital")
        assert len(cutmv) >= 4
        assert len(fd) >= 4

    def test_list_by_kind(self):
        from packages.agencyu.marketing.playbook_registry import PlaybookRegistry, seed_default_modules
        reg = PlaybookRegistry()
        seed_default_modules(reg)
        acq = reg.list_modules(kind="acquisition")
        assert len(acq) == 2  # one per brand

    def test_seed_default_modules(self):
        from packages.agencyu.marketing.playbook_registry import PlaybookRegistry, seed_default_modules
        reg = PlaybookRegistry()
        seed_default_modules(reg)
        assert reg.count() == 10


# ═══════════════════════════════════════════
# marketing/experiment_matrix.py
# ═══════════════════════════════════════════


class TestExperimentMatrix:
    def _load_config(self):
        import yaml
        with open("packages/agencyu/config/variants.yaml") as f:
            return yaml.safe_load(f)

    def test_generate_cutmv_combos(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_config()
        matrix = ExperimentMatrix(config=cfg)
        combos = matrix.generate("cutmv", limit=10)
        assert len(combos) == 10
        assert all(c.brand == "cutmv" for c in combos)
        assert all(len(c.combo_id) == 16 for c in combos)

    def test_stable_combo_ids(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_config()
        m1 = ExperimentMatrix(config=cfg)
        m2 = ExperimentMatrix(config=cfg)
        combos1 = m1.generate("cutmv", limit=5)
        combos2 = m2.generate("cutmv", limit=5)
        assert [c.combo_id for c in combos1] == [c.combo_id for c in combos2]

    def test_constraints(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_config()
        matrix = ExperimentMatrix(config=cfg)
        combos = matrix.generate("cutmv", constraints={"creative_ids": ["cutmv_ad_01"], "cta_ids": ["cta_comment_cut"]})
        assert all(c.creative_id == "cutmv_ad_01" for c in combos)
        assert all(c.cta_id == "cta_comment_cut" for c in combos)

    def test_count_possible(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_config()
        matrix = ExperimentMatrix(config=cfg)
        count = matrix.count_possible_combos("cutmv")
        # 10 creatives × 4 CTAs × 3 DM × 3 offers × 5 audiences = 1800
        assert count == 1800

    def test_fulldigital_combos(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_config()
        matrix = ExperimentMatrix(config=cfg)
        combos = matrix.generate("fulldigital", limit=5)
        assert len(combos) == 5
        assert all(c.brand == "fulldigital" for c in combos)

    def test_unknown_brand(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        matrix = ExperimentMatrix(config={})
        combos = matrix.generate("unknown")
        assert combos == []


# ═══════════════════════════════════════════
# marketing/attribution_ledger.py
# ═══════════════════════════════════════════


class TestAttributionLedger:
    def test_upsert_chain(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_abc", {
            "ghl_contact_id": "ghl_1", "manychat_contact_id": "mc_1",
        })
        chain = ledger.get_chain("chain_1")
        assert chain is not None
        assert chain["combo_id"] == "combo_abc"
        assert chain["ghl_contact_id"] == "ghl_1"

    def test_upsert_chain_updates(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_abc", {"ghl_contact_id": "ghl_1"})
        ledger.upsert_chain("chain_1", "cutmv", "combo_abc", {"stripe_customer_id": "cus_1"})
        chain = ledger.get_chain("chain_1")
        assert chain["ghl_contact_id"] == "ghl_1"
        assert chain["stripe_customer_id"] == "cus_1"

    def test_append_and_fetch_events(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_2", "cutmv", "combo_abc", {})
        ledger.append_event("chain_2", "ad_click", "meta", {"ad_id": "ad_1"})
        ledger.append_event("chain_2", "dm_started", "manychat", {"keyword": "CUT"})
        ledger.append_event("chain_2", "checkout_paid", "stripe", {"amount": 4900})

        events = ledger.fetch_chain_events("chain_2")
        assert len(events) == 3
        assert events[0].stage == "ad_click"
        assert events[2].stage == "checkout_paid"

    def test_get_chains_by_combo(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        ledger = AttributionLedger(conn)
        ledger.upsert_chain("c1", "cutmv", "combo_x", {})
        ledger.upsert_chain("c2", "cutmv", "combo_x", {})
        ledger.upsert_chain("c3", "cutmv", "combo_y", {})
        chains = ledger.get_chains_by_combo("combo_x")
        assert len(chains) == 2

    def test_combo_stats(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        ledger = AttributionLedger(conn)
        ledger.upsert_chain("c1", "cutmv", "combo_z", {})
        ledger.append_event("c1", "ad_click", "meta", {})
        ledger.append_event("c1", "checkout_paid", "stripe", {})
        stats = ledger.get_combo_stats("combo_z")
        assert stats["chains"] == 1
        assert stats["stages"]["ad_click"] == 1

    def test_top_combos(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        ledger = AttributionLedger(conn)
        ledger.upsert_chain("c1", "cutmv", "combo_a", {})
        ledger.upsert_chain("c2", "cutmv", "combo_a", {})
        ledger.upsert_chain("c3", "cutmv", "combo_b", {})
        top = ledger.get_top_combos_by_revenue(limit=5)
        assert len(top) == 2
        assert top[0]["combo_id"] == "combo_a"


# ═══════════════════════════════════════════
# marketing/brain.py
# ═══════════════════════════════════════════


class TestMarketingBrain:
    def test_init_defaults(self):
        from packages.agencyu.marketing.brain import MarketingBrain
        brain = MarketingBrain()
        assert "cutmv" in brain.brands
        assert "fulldigital" in brain.brands
        assert brain.brands["cutmv"].daily_budget == 50.0

    def test_launch_phase_1(self):
        from packages.agencyu.marketing.brain import MarketingBrain, Phase
        brain = MarketingBrain()
        result = brain.launch_phase_1()
        assert result["cutmv"]["status"] == "live"
        assert result["fulldigital"]["status"] == "live"
        assert brain.current_phase["cutmv"] == Phase.VALIDATION

    def test_run_daily_cycle(self):
        from packages.agencyu.marketing.brain import MarketingBrain
        brain = MarketingBrain()
        report = brain.run_daily_cycle()
        assert report.date == date.today().isoformat()
        assert "cutmv" in report.brands
        assert isinstance(report.decisions_made, list)
        assert isinstance(report.alerts, list)

    def test_phase_advancement(self):
        from packages.agencyu.marketing.brain import MarketingBrain, Phase
        brain = MarketingBrain()
        brain.brands["cutmv"].total_spend_to_date = 600
        brain.brands["cutmv"].active_campaigns = 3
        decisions = brain._check_phase_advancement()
        assert len(decisions) >= 1
        assert brain.current_phase["cutmv"] == Phase.OPTIMIZATION

    def test_budget_optimization_validation_phase(self):
        from packages.agencyu.marketing.brain import MarketingBrain, Phase
        brain = MarketingBrain()
        # In validation phase, budget should not change
        original = brain.brands["cutmv"].daily_budget
        decisions = brain._optimize_budget_allocation()
        assert brain.brands["cutmv"].daily_budget == original

    def test_export_state(self):
        from packages.agencyu.marketing.brain import MarketingBrain
        brain = MarketingBrain()
        state = brain.export_state()
        assert "brands" in state
        assert "cutmv" in state["brands"]
        assert "timestamp" in state

    def test_cross_sell_opportunities(self):
        from packages.agencyu.marketing.brain import MarketingBrain
        from packages.agencyu.engines.ltv_retention import Customer, CustomerStatus
        brain = MarketingBrain()
        c = Customer(
            id="c1", brand="cutmv", name="Test", email="t@t.com",
            plan="starter", mrr=19, start_date=date.today() - timedelta(days=60),
            status=CustomerStatus.ACTIVE, videos_processed_30d=10, nps_score=9,
        )
        brain.ltv.add_customer(c)
        opps = brain.identify_cross_sell_opportunities()
        assert len(opps) >= 1

    def test_with_conn_creates_ledger(self, conn):
        from packages.agencyu.marketing.brain import MarketingBrain
        brain = MarketingBrain(conn=conn)
        assert brain.ledger is not None

    def test_with_variants_config(self):
        import yaml
        from packages.agencyu.marketing.brain import MarketingBrain
        with open("packages/agencyu/config/variants.yaml") as f:
            cfg = yaml.safe_load(f)
        brain = MarketingBrain(variants_config=cfg)
        assert brain.experiment_matrix is not None


# ═══════════════════════════════════════════
# Experiment Policy — Daily Executor
# ═══════════════════════════════════════════


POLICY_PATH = "packages/agencyu/config/experiment_policy.yaml"


class TestExperimentPolicy:
    def test_policy_yaml_loads(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        assert policy["version"] == 1
        assert policy["global"]["max_daily_budget_usd"] == 80
        assert policy["global"]["max_active_combos"] == 30
        assert policy["rules"]["kill"]["cpa_multiplier_threshold"] == 3.0
        assert policy["rules"]["scale"]["roas_threshold"] == 2.0
        assert policy["creative_fatigue"]["thresholds"]["ctr_drop_pct"] == 35
        assert policy["brands"]["cutmv"]["daily_budget_usd"] == 40

    def test_run_blocked_by_write_lock(self, conn):
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        result = run_experiment_policy_daily(
            conn=conn,
            policy_path=POLICY_PATH,
            safe_mode=True,
            write_lock=True,
            correlation_id="test-lock",
        )
        assert result["ok"] is True
        assert result["simulate"] is True
        assert result["blocked_reason"] == "write_lock=true"
        assert result["actions"] == []

    def test_run_blocked_by_cooldown(self, conn):
        import time as _time
        from packages.agencyu.services.circuit_breaker import CircuitBreaker
        from packages.agencyu.marketing.brain import run_experiment_policy_daily

        # Trip the breaker
        breaker = CircuitBreaker(conn)
        breaker._set(breaker.KEY_COOLDOWN, str(int(_time.time()) + 3600))
        breaker._set(breaker.KEY_TRIP_REASON, "test_trip")

        result = run_experiment_policy_daily(
            conn=conn,
            policy_path=POLICY_PATH,
            safe_mode=False,
            write_lock=False,
            correlation_id="test-cooldown",
        )
        assert result["ok"] is True
        assert result["simulate"] is True
        assert "cooldown active" in result["blocked_reason"]
        assert result["actions"] == []

    def test_run_safe_mode_no_data(self, conn):
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        result = run_experiment_policy_daily(
            conn=conn,
            policy_path=POLICY_PATH,
            safe_mode=True,
            write_lock=False,
            correlation_id="test-safe",
        )
        assert result["ok"] is True
        assert result["simulate"] is True
        assert result["actions"] == []
        assert "no combo metrics available" in result["warnings"][0]

    def test_run_live_mode_no_data(self, conn):
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        result = run_experiment_policy_daily(
            conn=conn,
            policy_path=POLICY_PATH,
            safe_mode=False,
            write_lock=False,
            correlation_id="test-live",
        )
        assert result["ok"] is True
        assert result["simulate"] is False
        assert result["actions"] == []

    def test_combo_metrics_dataclass(self):
        from packages.agencyu.marketing.brain import ComboMetrics
        m = ComboMetrics(
            combo_id="abc123", brand="cutmv",
            impressions=5000, clicks=100, conversions=5,
            spend_usd=100.0, revenue_usd=300.0,
            ctr=2.0, cpm=20.0, frequency=1.5,
            cpa=20.0, roas=3.0,
        )
        assert m.combo_id == "abc123"
        assert m.roas == 3.0

    def test_compute_brand_baselines_with_winners(self):
        from packages.agencyu.marketing.brain import ComboMetrics, compute_brand_baselines
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        winners = [
            ComboMetrics("c1", "cutmv", 5000, 100, 5, 100, 300, 2.0, 20.0, 1.5, 20.0, 3.0),
            ComboMetrics("c2", "cutmv", 6000, 120, 8, 150, 500, 2.2, 22.0, 1.3, 18.75, 3.3),
            ComboMetrics("c3", "cutmv", 4000, 80, 3, 80, 200, 1.8, 18.0, 1.6, 26.67, 2.5),
        ]
        cpa, ctr, cpm = compute_brand_baselines(winners, policy, "cutmv")
        assert cpa == 20.0  # median of sorted [18.75, 20.0, 26.67]
        assert ctr == 2.0   # median of sorted [1.8, 2.0, 2.2]
        assert cpm == 20.0  # median of sorted [18.0, 20.0, 22.0]

    def test_compute_brand_baselines_fallback(self):
        from packages.agencyu.marketing.brain import compute_brand_baselines
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        cpa, ctr, cpm = compute_brand_baselines([], policy, "cutmv")
        assert cpa == 35.0  # fallback from policy
        assert ctr == 0.01
        assert cpm == 10.0

    def test_decide_hold_not_enough_data(self):
        from packages.agencyu.marketing.brain import ComboMetrics, decide_combo_action
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        m = ComboMetrics("c1", "cutmv", 100, 5, 0, 5.0, 0, 0.05, 10.0, 0.5, 0, 0)
        decision, detail = decide_combo_action(
            m=m, policy=policy, brand="cutmv",
            baseline_cpa=35.0, baseline_ctr=0.01, baseline_cpm=10.0,
        )
        assert decision is None
        assert detail["reason"] == "hold_minimums_not_met"

    def test_decide_kill_zero_conversion(self):
        from packages.agencyu.marketing.brain import ComboMetrics, decide_combo_action
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        m = ComboMetrics("c1", "cutmv", 5000, 100, 0, 70.0, 0, 1.5, 14.0, 1.8, 0, 0)
        decision, detail = decide_combo_action(
            m=m, policy=policy, brand="cutmv",
            baseline_cpa=35.0, baseline_ctr=2.0, baseline_cpm=10.0,
        )
        assert decision == "pause"
        assert detail["reason"] == "zero_conversion_guard"

    def test_decide_kill_high_cpa(self):
        from packages.agencyu.marketing.brain import ComboMetrics, decide_combo_action
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        # CPA=120 > baseline 35 * 3 = 105
        m = ComboMetrics("c1", "cutmv", 5000, 100, 3, 360.0, 50.0, 1.5, 14.0, 1.8, 120.0, 0.14)
        decision, detail = decide_combo_action(
            m=m, policy=policy, brand="cutmv",
            baseline_cpa=35.0, baseline_ctr=2.0, baseline_cpm=10.0,
        )
        assert decision == "pause"
        assert detail["reason"] == "kill_cpa_3x"

    def test_decide_fatigue(self):
        from packages.agencyu.marketing.brain import ComboMetrics, decide_combo_action
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        # frequency 3.0 > threshold 2.5 → fatigue
        m = ComboMetrics("c1", "cutmv", 5000, 100, 2, 50.0, 100.0, 1.5, 14.0, 3.0, 25.0, 2.0)
        decision, detail = decide_combo_action(
            m=m, policy=policy, brand="cutmv",
            baseline_cpa=35.0, baseline_ctr=2.0, baseline_cpm=10.0,
        )
        assert decision == "rotate_creative"
        assert detail["reason"] == "creative_fatigue"

    def test_decide_scale(self):
        from packages.agencyu.marketing.brain import ComboMetrics, decide_combo_action
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        # ROAS 3.0 >= 2.0, healthy combo
        m = ComboMetrics("c1", "cutmv", 5000, 100, 5, 100.0, 300.0, 2.0, 20.0, 1.5, 20.0, 3.0)
        decision, detail = decide_combo_action(
            m=m, policy=policy, brand="cutmv",
            baseline_cpa=35.0, baseline_ctr=2.0, baseline_cpm=20.0,
        )
        assert decision == "scale_budget"
        assert detail["reason"] == "scale_roas_2x"
        assert detail["max_scale_step_pct"] == 25.0

    def test_pct_drop_and_increase(self):
        from packages.agencyu.marketing.brain import _pct_drop, _pct_increase
        assert _pct_drop(2.0, 1.0) == 50.0
        assert _pct_drop(2.0, 2.0) == 0.0
        assert _pct_drop(0, 1.0) == 0.0
        assert _pct_increase(10.0, 15.0) == 50.0
        assert _pct_increase(10.0, 10.0) == 0.0
        assert _pct_increase(0, 5.0) == 0.0

    def test_build_policy_warnings_empty(self):
        from packages.agencyu.marketing.brain import build_policy_warnings
        warnings = build_policy_warnings({}, [])
        assert "no combo metrics available" in warnings[0]

    def test_run_with_injected_metrics(self, conn):
        from packages.agencyu.marketing.brain import (
            run_experiment_policy_daily,
            ComboMetrics,
            aggregate_combo_metrics_contract,
        )
        from unittest.mock import patch

        fake_metrics = [
            ComboMetrics("c1", "cutmv", 5000, 100, 5, 100.0, 300.0, 2.0, 20.0, 1.5, 20.0, 3.0),
            ComboMetrics("c2", "cutmv", 5000, 100, 0, 70.0, 0, 1.5, 14.0, 1.8, 0, 0),
        ]

        with patch(
            "packages.agencyu.marketing.brain.aggregate_combo_metrics_contract",
            return_value=fake_metrics,
        ):
            result = run_experiment_policy_daily(
                conn=conn,
                policy_path=POLICY_PATH,
                safe_mode=True,
                write_lock=False,
                correlation_id="test-inject",
            )
        assert result["ok"] is True
        assert len(result["actions"]) >= 1
        # c1 should scale (ROAS 3.0 >= 2.0), c2 should kill (zero conv, $70 > $60)
        decisions = {a["combo_id"]: a["decision"] for a in result["actions"]}
        assert decisions.get("c1") == "scale_budget"
        assert decisions.get("c2") == "pause"

    def test_fulldigital_min_conversions_override(self):
        from packages.agencyu.marketing.brain import ComboMetrics, decide_combo_action
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        # fulldigital: min_conversions=1 (overridden from default 3)
        # ROAS 2.5 >= 2.0 with only 1 conversion → should scale
        m = ComboMetrics("c1", "fulldigital", 5000, 100, 1, 100.0, 250.0, 2.0, 20.0, 1.0, 100.0, 2.5)
        decision, detail = decide_combo_action(
            m=m, policy=policy, brand="fulldigital",
            baseline_cpa=120.0, baseline_ctr=2.0, baseline_cpm=20.0,
        )
        assert decision == "scale_budget"

    def test_max_actions_cap(self, conn):
        from packages.agencyu.marketing.brain import (
            run_experiment_policy_daily,
            ComboMetrics,
        )
        from unittest.mock import patch

        # Create 30 combos that should all trigger scale
        fake_metrics = [
            ComboMetrics(
                f"c{i}", "cutmv", 5000, 100, 5, 100.0, 300.0, 2.0, 20.0, 1.5, 20.0, 3.0
            )
            for i in range(30)
        ]

        with patch(
            "packages.agencyu.marketing.brain.aggregate_combo_metrics_contract",
            return_value=fake_metrics,
        ):
            result = run_experiment_policy_daily(
                conn=conn,
                policy_path=POLICY_PATH,
                safe_mode=True,
                write_lock=False,
            )
        # Should be capped at max_actions_per_run (25) but also limited by
        # max_active_combos for cutmv (20)
        assert len(result["actions"]) <= 25


# ═══════════════════════════════════════════
# Offer Catalog — offers_full_digital.yaml
# ═══════════════════════════════════════════

OFFERS_CATALOG_PATH = "packages/agencyu/config/offers_full_digital.yaml"


class TestOfferCatalog:
    def test_catalog_loads(self):
        import yaml
        with open(OFFERS_CATALOG_PATH) as f:
            catalog = yaml.safe_load(f)
        assert catalog["version"] == 1
        assert catalog["brand"] == "fulldigital"
        assert len(catalog["offers"]) == 8

    def test_all_offers_have_required_fields(self):
        import yaml
        with open(OFFERS_CATALOG_PATH) as f:
            catalog = yaml.safe_load(f)
        for offer in catalog["offers"]:
            assert "id" in offer
            assert "name" in offer
            assert "category" in offer
            assert "outcome" in offer
            assert "deliverables" in offer
            assert "tiers" in offer
            assert "ad_angles" in offer
            assert offer["id"].startswith("fd_offer_")

    def test_tiers_have_pricing(self):
        import yaml
        with open(OFFERS_CATALOG_PATH) as f:
            catalog = yaml.safe_load(f)
        for offer in catalog["offers"]:
            for tier_name in ("lite", "pro", "elite"):
                tier = offer["tiers"].get(tier_name)
                assert tier is not None, f"{offer['id']} missing tier {tier_name}"
                assert tier["anchor_price_usd"] > 0
                assert tier["timeline_days"] > 0

    def test_offer_ids_unique(self):
        import yaml
        with open(OFFERS_CATALOG_PATH) as f:
            catalog = yaml.safe_load(f)
        ids = [o["id"] for o in catalog["offers"]]
        assert len(ids) == len(set(ids))


# ═══════════════════════════════════════════
# Offer Rotation Policy
# ═══════════════════════════════════════════


class TestOfferRotationPolicy:
    def test_offer_rotation_in_policy(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        rot = policy["offer_rotation"]
        assert rot["enabled"] is True
        assert rot["strategy"] == "multi_armed_bandit_softmax"
        assert rot["exploration_pct"] == 30
        assert rot["guardrails"]["never_exceed_active_offers_per_brand"] == 6
        assert len(rot["starter_rack"]) == 6

    def test_starter_rack_ids_exist_in_catalog(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        with open(OFFERS_CATALOG_PATH) as f:
            catalog = yaml.safe_load(f)
        catalog_ids = {o["id"] for o in catalog["offers"]}
        for rack_id in policy["offer_rotation"]["starter_rack"]:
            assert rack_id in catalog_ids, f"{rack_id} not in catalog"


# ═══════════════════════════════════════════
# Experiment Matrix — Offer Catalog Integration
# ═══════════════════════════════════════════


class TestExperimentMatrixOfferCatalog:
    def _load_variants(self):
        import yaml
        with open("packages/agencyu/config/variants.yaml") as f:
            return yaml.safe_load(f)

    def test_fulldigital_uses_catalog_offers(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_variants()
        matrix = ExperimentMatrix(config=cfg)
        combos = matrix.generate("fulldigital", limit=10)
        assert len(combos) > 0
        # Should use starter rack offers (6 from catalog)
        offer_ids = {c.offer_id for c in combos}
        # At least some should be from the catalog
        catalog_ids = {"fd_offer_01_visual_era", "fd_offer_02_viral_launch_engine"}
        assert offer_ids & catalog_ids

    def test_fulldigital_respects_offer_cap(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_variants()
        matrix = ExperimentMatrix(config=cfg)
        combos = matrix.generate("fulldigital")
        offer_ids = {c.offer_id for c in combos}
        # Should be capped at 6 (starter rack)
        assert len(offer_ids) <= 6

    def test_cutmv_unaffected_by_catalog(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_variants()
        matrix = ExperimentMatrix(config=cfg)
        combos = matrix.generate("cutmv", limit=10)
        assert len(combos) > 0
        # CUTMV offers should come from variants.yaml, not the catalog
        offer_ids = {c.offer_id for c in combos}
        assert any(o.startswith("offer_") for o in offer_ids)

    def test_count_possible_fulldigital_with_catalog(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_variants()
        matrix = ExperimentMatrix(config=cfg)
        count = matrix.count_possible_combos("fulldigital")
        # 10 creatives * 4 CTAs * 3 DM copies * 6 offers (starter rack) * 5 audiences
        assert count == 10 * 4 * 3 * 6 * 5

    def test_offer_constraint_overrides_catalog(self):
        from packages.agencyu.marketing.experiment_matrix import ExperimentMatrix
        cfg = self._load_variants()
        matrix = ExperimentMatrix(config=cfg)
        combos = matrix.generate(
            "fulldigital",
            constraints={"offer_ids": ["fd_offer_01_visual_era"]},
        )
        offer_ids = {c.offer_id for c in combos}
        assert offer_ids == {"fd_offer_01_visual_era"}

    def test_load_offer_catalog(self):
        from packages.agencyu.marketing.experiment_matrix import load_offer_catalog
        offers = load_offer_catalog()
        assert len(offers) == 8
        assert all("id" in o and "name" in o for o in offers)

    def test_load_rotation_policy(self):
        from packages.agencyu.marketing.experiment_matrix import load_offer_rotation_policy
        policy = load_offer_rotation_policy()
        assert policy["enabled"] is True
        assert len(policy["starter_rack"]) == 6


# ═══════════════════════════════════════════
# Meta Insights Client
# ═══════════════════════════════════════════


class TestMetaInsightsClient:
    def test_config_defaults(self):
        from packages.agencyu.integrations.meta_insights import MetaInsightsConfig
        cfg = MetaInsightsConfig()
        assert cfg.api_version == "v20.0"
        assert cfg.max_retries == 5
        assert cfg.timeout_sec == 30

    def test_url_construction(self):
        from packages.agencyu.integrations.meta_insights import (
            MetaInsightsClient, MetaInsightsConfig,
        )
        cfg = MetaInsightsConfig(access_token="tok", ad_account_id="act_123")
        client = MetaInsightsClient(cfg)
        assert client._url("act_123/insights") == "https://graph.facebook.com/v20.0/act_123/insights"

    def test_rate_limiter(self):
        import time as _time
        from packages.agencyu.integrations.meta_insights import MetaRateLimiter
        limiter = MetaRateLimiter(min_interval_sec=0.01)
        limiter.wait()
        t0 = _time.monotonic()
        limiter.wait()
        elapsed = _time.monotonic() - t0
        # Should have waited at least ~0.01s
        assert elapsed >= 0.005

    def test_get_returns_error_on_failure(self):
        from packages.agencyu.integrations.meta_insights import (
            MetaInsightsClient, MetaInsightsConfig, MetaRateLimiter,
        )
        cfg = MetaInsightsConfig(
            access_token="bad", ad_account_id="act_000",
            base_url="http://localhost:1", timeout_sec=1, max_retries=1,
        )
        limiter = MetaRateLimiter(min_interval_sec=0)
        client = MetaInsightsClient(cfg, limiter=limiter)
        result = client._get("test", {})
        assert "error" in result
        assert result["error"]["status"] == "retry_exhausted"


# ═══════════════════════════════════════════
# Metrics Aggregator
# ═══════════════════════════════════════════


class TestMetricsAggregator:
    def test_extract_combo_id_from_name(self):
        from packages.agencyu.marketing.metrics_aggregator import extract_combo_id_from_name
        assert extract_combo_id_from_name("CUTMV combo:abc123 Test") == "abc123"
        assert extract_combo_id_from_name("combo_id=def456 Campaign") == "def456"
        assert extract_combo_id_from_name("No combo here") is None
        assert extract_combo_id_from_name("") is None
        assert extract_combo_id_from_name(None) is None

    def test_aggregate_with_mock_meta(self, conn):
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import (
            MetricsAggregator, AggregatorConfig,
        )
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(conn)
        mock_meta = MagicMock()
        mock_meta.fetch_ad_insights.return_value = {
            "data": [
                {
                    "ad_name": "CUTMV combo:abc123 Split",
                    "impressions": "5000",
                    "clicks": "100",
                    "spend": "50.00",
                    "ctr": "2.0",
                    "cpm": "10.0",
                    "frequency": "1.5",
                },
                {
                    "ad_name": "CUTMV combo:abc123 Variant B",
                    "impressions": "3000",
                    "clicks": "60",
                    "spend": "30.00",
                    "ctr": "2.2",
                    "cpm": "12.0",
                    "frequency": "1.3",
                },
            ]
        }

        agg = MetricsAggregator(meta=mock_meta, ledger=ledger)
        metrics = agg.aggregate(AggregatorConfig(brand="cutmv", since="2026-03-01", until="2026-03-04"))

        assert len(metrics) == 1
        m = metrics[0]
        assert m.combo_id == "abc123"
        assert m.impressions == 8000
        assert m.clicks == 160
        assert m.spend_usd == 80.0
        # Averages: (2.0+2.2)/2 = 2.1
        assert abs(m.ctr - 2.1) < 0.01

    def test_aggregate_error_returns_empty(self, conn):
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import (
            MetricsAggregator, AggregatorConfig,
        )
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(conn)
        mock_meta = MagicMock()
        mock_meta.fetch_ad_insights.return_value = {"error": {"status": 401}}

        agg = MetricsAggregator(meta=mock_meta, ledger=ledger)
        metrics = agg.aggregate(AggregatorConfig(brand="cutmv", since="2026-03-01", until="2026-03-04"))
        assert metrics == []

    def test_count_conversions_windowed(self, conn):
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import MetricsAggregator
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_abc", {})
        ledger.append_event("chain_1", "checkout_paid", "stripe", {"amount_usd": 19})

        agg = MetricsAggregator(meta=MagicMock(), ledger=ledger)
        # Within window
        count = agg.count_conversions(
            "cutmv", "combo_abc", ["checkout_paid"],
            "2020-01-01T00:00:00", "2030-12-31T23:59:59",
        )
        assert count == 1

    def test_count_conversions_outside_window(self, conn):
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import MetricsAggregator
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_abc2", {})
        ledger.append_event("chain_1", "checkout_paid", "stripe", {"amount_usd": 19})

        agg = MetricsAggregator(meta=MagicMock(), ledger=ledger)
        # Window in the past — should miss the event
        count = agg.count_conversions(
            "cutmv", "combo_abc2", ["checkout_paid"],
            "2020-01-01T00:00:00", "2020-01-02T00:00:00",
        )
        assert count == 0

    def test_sum_revenue_windowed_amount_usd(self, conn):
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import MetricsAggregator
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_rev", {})
        ledger.append_event("chain_1", "checkout_paid", "stripe", {"amount_usd": 49.99})

        agg = MetricsAggregator(meta=MagicMock(), ledger=ledger)
        revenue = agg.sum_revenue(
            "cutmv", "combo_rev",
            "2020-01-01T00:00:00", "2030-12-31T23:59:59",
        )
        assert revenue == pytest.approx(49.99, abs=0.01)

    def test_sum_revenue_cents_fallback(self, conn):
        """When payload has amount (cents) instead of amount_usd, divide by 100."""
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import MetricsAggregator
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_cents", {})
        # Stripe-style: amount in cents
        ledger.append_event("chain_1", "checkout_paid", "stripe", {"amount": 4999, "currency": "usd"})

        agg = MetricsAggregator(meta=MagicMock(), ledger=ledger)
        revenue = agg.sum_revenue(
            "cutmv", "combo_cents",
            "2020-01-01T00:00:00", "2030-12-31T23:59:59",
        )
        assert revenue == pytest.approx(49.99, abs=0.01)

    def test_sum_revenue_outside_window(self, conn):
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import MetricsAggregator
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_norev", {})
        ledger.append_event("chain_1", "checkout_paid", "stripe", {"amount_usd": 100})

        agg = MetricsAggregator(meta=MagicMock(), ledger=ledger)
        revenue = agg.sum_revenue(
            "cutmv", "combo_norev",
            "2020-01-01T00:00:00", "2020-01-02T00:00:00",
        )
        assert revenue == 0.0

    def test_dual_conversion_fulldigital(self, conn):
        """Full Digital aggregate produces ComboMetricsFD with pipeline + revenue."""
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import (
            MetricsAggregator, AggregatorConfig,
        )
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        import yaml

        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)

        ledger = AttributionLedger(conn)
        # Create chain with pipeline + revenue events
        ledger.upsert_chain("chain_fd1", "fulldigital", "combo_fd", {})
        ledger.append_event("chain_fd1", "booking_complete", "calendly", {})
        ledger.append_event("chain_fd1", "application_submit", "clickfunnels", {})
        ledger.append_event("chain_fd1", "checkout_paid", "stripe", {"amount_usd": 3000})

        mock_meta = MagicMock()
        mock_meta.fetch_ad_insights.return_value = {
            "data": [{
                "ad_name": "FD combo:combo_fd Visual Era",
                "impressions": "5000",
                "clicks": "100",
                "spend": "200.00",
                "ctr": "2.0",
                "cpm": "40.0",
                "frequency": "1.2",
            }]
        }

        agg = MetricsAggregator(meta=mock_meta, ledger=ledger, policy=policy)
        metrics = agg.aggregate(AggregatorConfig(
            brand="fulldigital", since="2020-01-01", until="2030-12-31",
        ))

        assert len(metrics) == 1
        m = metrics[0]
        assert isinstance(m, ComboMetricsFD)
        assert m.combo_id == "combo_fd"
        # Policy sees pipeline as primary conversion (2)
        assert m.conversions == 2
        # Pipeline = booking_complete + application_submit (2)
        assert m.pipeline_conversions == 2
        assert m.bookings == 1
        assert m.application_submits == 1
        # Revenue = checkout_paid (1)
        assert m.revenue_conversions == 1
        assert m.revenue_usd == pytest.approx(3000.0)
        assert m.roas == pytest.approx(15.0)  # 3000/200
        # CPA = pipeline CPA = 200/2 = 100
        assert m.pipeline_cpa == pytest.approx(100.0)
        assert m.cpa == pytest.approx(100.0)
        # Revenue CPA = 200/1 = 200
        assert m.revenue_cpa == pytest.approx(200.0)
        # Close rate = closes / calls_observed
        # calls_observed = calls_showed (0) fallback → calls_booked (1)
        # close_rate = 1/1 = 1.0
        assert m.close_rate == pytest.approx(1.0)

    def test_dual_conversion_cutmv_not_fd_type(self, conn):
        """CUTMV emits base ComboMetrics, not ComboMetricsFD."""
        from unittest.mock import MagicMock
        from packages.agencyu.marketing.metrics_aggregator import (
            MetricsAggregator, AggregatorConfig,
        )
        from packages.agencyu.marketing.metrics_types import ComboMetrics, ComboMetricsFD
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        import yaml

        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("chain_c1", "cutmv", "combo_c", {})
        ledger.append_event("chain_c1", "checkout_paid", "stripe", {"amount_usd": 49})

        mock_meta = MagicMock()
        mock_meta.fetch_ad_insights.return_value = {
            "data": [{
                "ad_name": "CUTMV combo:combo_c Speed Demo",
                "impressions": "3000",
                "clicks": "80",
                "spend": "40.00",
                "ctr": "2.67",
                "cpm": "13.33",
                "frequency": "1.0",
            }]
        }

        agg = MetricsAggregator(meta=mock_meta, ledger=ledger, policy=policy)
        metrics = agg.aggregate(AggregatorConfig(
            brand="cutmv", since="2020-01-01", until="2030-12-31",
        ))

        assert len(metrics) == 1
        m = metrics[0]
        assert not isinstance(m, ComboMetricsFD)
        assert isinstance(m, ComboMetrics)
        assert m.conversions == 1
        assert m.pipeline_conversions == 1
        assert m.revenue_conversions == 1

    def test_policy_defines_dual_conversions(self):
        """Verify fulldigital policy has pipeline_stages + revenue_stage."""
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        fd = policy["definitions"]["brand_conversions"]["fulldigital"]
        assert fd["primary"] == "booking_complete"
        assert "booking_complete" in fd["pipeline_stages"]
        assert "application_submit" in fd["pipeline_stages"]
        assert fd["revenue_stage"] == "checkout_paid"
        # CUTMV also has revenue_stage
        cutmv = policy["definitions"]["brand_conversions"]["cutmv"]
        assert cutmv["revenue_stage"] == "checkout_paid"

    def test_compute_evaluation_window(self):
        from packages.agencyu.marketing.metrics_aggregator import compute_evaluation_window
        since, until = compute_evaluation_window(72)
        assert len(since) == 10  # YYYY-MM-DD
        assert len(until) == 10

    def test_aggregate_no_meta_credentials(self, conn):
        """aggregate_combo_metrics_contract returns [] when no META env vars."""
        import os
        from packages.agencyu.marketing.brain import aggregate_combo_metrics_contract
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        import yaml

        ledger = AttributionLedger(conn)
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)

        # Ensure env vars are not set
        old_token = os.environ.pop("META_ACCESS_TOKEN", None)
        old_account = os.environ.pop("META_AD_ACCOUNT_ID", None)
        try:
            result = aggregate_combo_metrics_contract(ledger=ledger, policy=policy)
            assert result == []
        finally:
            if old_token:
                os.environ["META_ACCESS_TOKEN"] = old_token
            if old_account:
                os.environ["META_AD_ACCOUNT_ID"] = old_account


# ═══════════════════════════════════════════
# Metrics Types — ComboMetrics + ComboMetricsFD
# ═══════════════════════════════════════════


class TestMetricsTypes:
    def test_combo_metrics_fd_is_subclass(self):
        from packages.agencyu.marketing.metrics_types import ComboMetrics, ComboMetricsFD
        m = ComboMetricsFD(
            combo_id="x", brand="fulldigital",
            impressions=1000, clicks=50, conversions=5,
            spend_usd=100, revenue_usd=500,
            ctr=5.0, cpm=100.0, frequency=1.0,
            cpa=20.0, roas=5.0,
            pipeline_conversions=5, revenue_conversions=2,
            pipeline_cpa=20.0, revenue_cpa=50.0, close_rate=0.4,
            bookings=3, application_submits=2,
        )
        assert isinstance(m, ComboMetrics)
        assert isinstance(m, ComboMetricsFD)

    def test_combo_metrics_fd_defaults(self):
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        m = ComboMetricsFD(
            combo_id="x", brand="fulldigital",
            impressions=0, clicks=0, conversions=0,
            spend_usd=0, revenue_usd=0,
            ctr=0, cpm=0, frequency=0, cpa=0, roas=0,
        )
        assert m.pipeline_cpa == 0.0
        assert m.revenue_cpa == 0.0
        assert m.close_rate == 0.0
        assert m.bookings == 0
        assert m.application_submits == 0

    def test_combo_metrics_re_exported_from_brain(self):
        """ComboMetrics imported from brain.py should be the same class."""
        from packages.agencyu.marketing.brain import ComboMetrics as BrainCM
        from packages.agencyu.marketing.metrics_types import ComboMetrics as TypesCM
        assert BrainCM is TypesCM

    def test_combo_metrics_fd_re_exported_from_brain(self):
        from packages.agencyu.marketing.brain import ComboMetricsFD as BrainFD
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD as TypesFD
        assert BrainFD is TypesFD


# ═══════════════════════════════════════════
# Daily Reporting
# ═══════════════════════════════════════════


class TestDailyReporting:
    def test_render_empty_report(self):
        from packages.agencyu.marketing.reporting import render_daily_report
        report = render_daily_report([], [])
        assert report["summary"]["combos_total"] == 0
        assert report["fulldigital_dual_conversion_leaderboard"] == []

    def test_render_report_with_cutmv_only(self):
        from packages.agencyu.marketing.reporting import render_daily_report
        from packages.agencyu.marketing.metrics_types import ComboMetrics
        metrics = [
            ComboMetrics("c1", "cutmv", 5000, 100, 5, 100, 300, 2.0, 20, 1.5, 20, 3.0),
            ComboMetrics("c2", "cutmv", 3000, 60, 2, 50, 100, 2.0, 17, 1.2, 25, 2.0),
        ]
        report = render_daily_report(metrics, [{"combo_id": "c1", "decision": "scale"}])
        assert report["summary"]["cutmv_combos"] == 2
        assert report["summary"]["fulldigital_combos"] == 0
        assert report["summary"]["actions_planned"] == 1
        assert len(report["top"]["roas"]) == 2
        assert report["fulldigital_dual_conversion_leaderboard"] == []

    def test_render_report_with_fd_dual_conversion(self):
        from packages.agencyu.marketing.reporting import render_daily_report
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        fd = ComboMetricsFD(
            combo_id="fd1", brand="fulldigital",
            impressions=5000, clicks=100, conversions=4,
            spend_usd=200, revenue_usd=3000,
            ctr=2.0, cpm=40, frequency=1.2, cpa=50, roas=15.0,
            pipeline_conversions=4, revenue_conversions=2,
            pipeline_cpa=50, revenue_cpa=100, close_rate=0.5,
            bookings=3, application_submits=1,
        )
        report = render_daily_report([fd], [])
        lb = report["fulldigital_dual_conversion_leaderboard"]
        assert len(lb) == 1
        assert lb[0]["combo_id"] == "fd1"
        assert lb[0]["close_rate"] == 0.5
        assert lb[0]["pipeline_cpa"] == 50
        assert lb[0]["revenue_cpa"] == 100
        assert lb[0]["bookings"] == 3
        assert lb[0]["application_submits"] == 1

    def test_rank_top_bottom(self):
        from packages.agencyu.marketing.reporting import rank_top_bottom
        from packages.agencyu.marketing.metrics_types import ComboMetrics
        metrics = [
            ComboMetrics("a", "cutmv", 0, 0, 0, 0, 0, 0, 0, 0, 0, roas=1.0),
            ComboMetrics("b", "cutmv", 0, 0, 0, 0, 0, 0, 0, 0, 0, roas=5.0),
            ComboMetrics("c", "cutmv", 0, 0, 0, 0, 0, 0, 0, 0, 0, roas=3.0),
        ]
        top, bottom = rank_top_bottom(metrics, key="roas", n=2)
        assert [m.combo_id for m in top] == ["b", "c"]
        assert [m.combo_id for m in bottom] == ["a", "c"]

    def test_policy_daily_includes_report(self, conn):
        """run_experiment_policy_daily should include a 'report' key."""
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        result = run_experiment_policy_daily(
            conn=conn, safe_mode=True, write_lock=False,
        )
        assert "report" in result
        assert "summary" in result["report"]
        assert "fulldigital_dual_conversion_leaderboard" in result["report"]


# ═══════════════════════════════════════════
# Optimization Mode Config
# ═══════════════════════════════════════════


class TestOptimizationModeConfig:
    def test_fulldigital_has_optimization_mode(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        fd = policy["brands"]["fulldigital"]
        assert fd["optimization_mode"] == "pipeline"


# ═══════════════════════════════════════════
# Quality Gate — Full Digital Close Rate Guard
# ═══════════════════════════════════════════


class TestQualityGate:
    def _make_fd_metrics(self, **overrides):
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        defaults = dict(
            combo_id="fd_combo_1", brand="fulldigital",
            impressions=10000, clicks=200, conversions=25,
            spend_usd=600, revenue_usd=500,
            ctr=2.0, cpm=10, frequency=1.5, cpa=4.0, roas=5.0,
            pipeline_conversions=25, revenue_conversions=2,
            pipeline_cpa=4.0, revenue_cpa=50.0, close_rate=0.08,
            bookings=20, application_submits=5,
            attended_calls=15, show_rate=0.75,
            calls_observed=25, qualified_count=10,
            qualified_rate=0.4, avg_lead_score=70.0,
        )
        defaults.update(overrides)
        return ComboMetricsFD(**defaults)

    def _make_policy(self, **gate_overrides):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        if gate_overrides:
            gate = policy["brands"]["fulldigital"]["quality_gate"]
            gate.update(gate_overrides)
        return policy

    def test_gate_config_in_policy(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        gate = policy["brands"]["fulldigital"]["quality_gate"]
        assert gate["enabled"] is True
        assert gate["min_pipeline_conversions"] == 20
        assert gate["close_rate_min"] == 0.05
        assert gate["min_spend_usd"] == 50
        assert gate["decision"] == "block_scale"

    def test_gate_blocks_scale_low_close_rate(self):
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(
            pipeline_conversions=25, revenue_conversions=1,
            close_rate=0.04, spend_usd=600,
        )
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"
        assert block is not None
        assert block["original_decision"] == "scale_budget"
        assert block["gated_decision"] == "hold"
        assert block["close_rate"] == 0.04

    def test_gate_allows_scale_good_close_rate(self):
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(
            pipeline_conversions=25, revenue_conversions=3,
            close_rate=0.12, spend_usd=600,
        )
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "scale_budget"  # not gated
        assert block is None

    def test_gate_skips_non_scale_decisions(self):
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(close_rate=0.0, pipeline_conversions=30)
        for decision in ("pause", "hold", "rotate_creative"):
            action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": decision, "detail": {}}
            gated, block = apply_quality_gate(action, m, policy)
            assert gated["decision"] == decision
            assert block is None

    def test_gate_holds_when_not_enough_pipeline(self):
        """With PQM enabled, insufficient pipeline → hold (not pass-through)."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(
            pipeline_conversions=5, close_rate=0.0, spend_usd=100,
            calls_observed=5,
        )
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"  # PQM blocks
        assert block is not None
        assert block["gate_stage"] == "pipeline_quality_minimum"

    def test_gate_holds_when_not_enough_spend(self):
        """With PQM enabled, insufficient spend → hold (PQM blocks)."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(
            pipeline_conversions=25, close_rate=0.0, spend_usd=10,
        )
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"  # PQM blocks due to low spend
        assert block is not None
        assert block["gate_stage"] == "pipeline_quality_minimum"

    def test_close_rate_gate_skips_below_min_spend(self):
        """Close-rate gate's own min_spend check: spend below gate threshold but above PQM → scale."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(
            pipeline_conversions=25, close_rate=0.0, spend_usd=510,
        )
        # spend=510 passes PQM (>500) but is below close-rate gate's check threshold
        # close-rate gate needs min_pipeline=20 (met) AND min_spend=50 (met) → gate evaluates
        # close_rate=0.0 < 0.05 AND <= hard_fail 0.02 → hard fail → pause
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "pause"
        assert block["gate_stage"] == "close_rate_hard_fail"

    def test_gate_disabled_allows_scale(self):
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy(enabled=False)
        m = self._make_fd_metrics(close_rate=0.0, pipeline_conversions=30, spend_usd=100)
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "scale_budget"
        assert block is None

    def test_gate_block_scale_and_kill_mode(self):
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy(decision="block_scale_and_kill")
        m = self._make_fd_metrics(
            pipeline_conversions=25, close_rate=0.01, spend_usd=600,
        )
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "pause"
        assert block is not None
        assert block["gated_decision"] == "pause"

    def test_gate_hold_includes_budget_cap(self):
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(
            pipeline_conversions=25, close_rate=0.03, spend_usd=600,
        )
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"
        assert gated["detail"]["cap_daily_budget_usd"] == 10

    def test_gate_at_exact_threshold(self):
        """At exactly close_rate_min (0.05), gate should NOT trigger."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        policy = self._make_policy()
        m = self._make_fd_metrics(
            pipeline_conversions=20, close_rate=0.05, spend_usd=600,
        )
        action = {"combo_id": m.combo_id, "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "scale_budget"
        assert block is None

    def test_gate_integrated_in_policy_daily(self, conn):
        """Quality gate blocks appear in run_experiment_policy_daily report."""
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        result = run_experiment_policy_daily(
            conn=conn, safe_mode=True, write_lock=False,
        )
        # Even with no data, report should have quality_gate_blocks key
        assert "quality_gate_blocks" in result["report"]
        assert isinstance(result["report"]["quality_gate_blocks"], list)
        assert result["report"]["summary"]["quality_gate_blocks"] == 0

    def test_gate_end_to_end_with_injected_metrics(self, conn):
        """Inject FD metrics with bad close rate, verify gate blocks scale."""
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        from unittest.mock import patch

        # Combo with great ROAS but terrible close rate
        junk_winner = ComboMetricsFD(
            combo_id="fd_junk", brand="fulldigital",
            impressions=10000, clicks=200, conversions=30,
            spend_usd=600, revenue_usd=500,
            ctr=2.0, cpm=10, frequency=1.0, cpa=3.33, roas=5.0,
            pipeline_conversions=30, revenue_conversions=0,
            pipeline_cpa=3.33, revenue_cpa=0.0, close_rate=0.0,
            bookings=25, application_submits=5,
            attended_calls=20, show_rate=0.80,
            calls_observed=25,
        )
        # Combo with good close rate
        good_combo = ComboMetricsFD(
            combo_id="fd_good", brand="fulldigital",
            impressions=10000, clicks=200, conversions=20,
            spend_usd=600, revenue_usd=1000,
            ctr=2.0, cpm=10, frequency=1.0, cpa=5.0, roas=10.0,
            pipeline_conversions=20, revenue_conversions=5,
            pipeline_cpa=5.0, revenue_cpa=20.0, close_rate=0.25,
            bookings=15, application_submits=5,
            attended_calls=12, show_rate=0.80,
            calls_observed=25,
        )

        with patch(
            "packages.agencyu.marketing.brain.aggregate_combo_metrics_contract",
            return_value=[junk_winner, good_combo],
        ):
            result = run_experiment_policy_daily(
                conn=conn, safe_mode=True, write_lock=False,
            )

        decisions = {a["combo_id"]: a["decision"] for a in result["actions"]}
        # Good combo should scale
        assert decisions.get("fd_good") == "scale_budget"
        # Junk winner: close_rate=0.0 <= hard_fail_close_rate=0.02 → pause
        assert decisions.get("fd_junk") == "pause"
        # Gate block should be in report
        assert len(result["report"]["quality_gate_blocks"]) == 1
        assert result["report"]["quality_gate_blocks"][0]["combo_id"] == "fd_junk"

    def test_report_shows_gate_blocks(self):
        from packages.agencyu.marketing.reporting import render_daily_report
        blocks = [{"combo_id": "x", "close_rate": 0.02, "gated_decision": "hold"}]
        report = render_daily_report([], [], gate_blocks=blocks)
        assert report["summary"]["quality_gate_blocks"] == 1
        assert report["quality_gate_blocks"] == blocks


# ═══════════════════════════════════════════
# Pipeline Quality Minimum + Hard Fail
# ═══════════════════════════════════════════


class TestPipelineQualityMinimum:
    """Tests for passes_pipeline_quality_minimum and its integration with the gate."""

    @pytest.fixture()
    def policy(self):
        return {
            "brands": {
                "fulldigital": {
                    "pipeline_quality_minimum": {
                        "enabled": True,
                        "min_calls_observed": 20,
                        "min_pipeline_conversions": 15,
                        "enabled_lead_score": False,
                        "min_avg_lead_score": 60,
                        "enabled_qualified_rate": False,
                        "min_qualified_rate": 0.35,
                    },
                    "quality_gate": {
                        "enabled": True,
                        "min_pipeline_conversions": 20,
                        "close_rate_min": 0.05,
                        "min_spend_usd": 50,
                        "hard_fail_close_rate": 0.02,
                        "hard_fail_action": "pause",
                        "decision": "block_scale",
                        "hold_mode": {
                            "action": "hold",
                            "cap_daily_budget_usd": 10,
                        },
                    },
                    "pipeline_integrity": {
                        "enabled": True,
                        "min_show_rate": 0.60,
                        "min_bookings_for_show_eval": 15,
                    },
                },
            },
        }

    def _make_fd(self, **overrides):
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        defaults = dict(
            combo_id="fd_test", brand="fulldigital",
            impressions=10000, clicks=200, conversions=25,
            spend_usd=100, revenue_usd=500,
            ctr=2.0, cpm=10, frequency=1.0, cpa=4.0, roas=5.0,
            pipeline_conversions=25, revenue_conversions=2,
            pipeline_cpa=4.0, revenue_cpa=50.0, close_rate=0.08,
            bookings=20, application_submits=5,
            attended_calls=15, show_rate=0.75,
            calls_observed=20, qualified_count=10,
            qualified_rate=0.4, avg_lead_score=75.0,
        )
        defaults.update(overrides)
        return ComboMetricsFD(**defaults)

    def test_passes_when_all_minimums_met(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        m = self._make_fd(calls_observed=25, pipeline_conversions=20)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is True
        assert reason is None

    def test_fails_when_calls_too_low(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        m = self._make_fd(calls_observed=10)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is False
        assert "calls_observed=10" in reason

    def test_fails_when_pipeline_too_low(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        m = self._make_fd(calls_observed=25, pipeline_conversions=5)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is False
        assert "pipeline_conversions=5" in reason

    def test_passes_when_disabled(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        policy["brands"]["fulldigital"]["pipeline_quality_minimum"]["enabled"] = False
        m = self._make_fd(calls_observed=0, pipeline_conversions=0)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is True

    def test_lead_score_check_when_enabled(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        policy["brands"]["fulldigital"]["pipeline_quality_minimum"]["enabled_lead_score"] = True
        m = self._make_fd(avg_lead_score=40.0)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is False
        assert "avg_lead_score=40.0" in reason

    def test_lead_score_passes_when_high(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        policy["brands"]["fulldigital"]["pipeline_quality_minimum"]["enabled_lead_score"] = True
        m = self._make_fd(avg_lead_score=80.0)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is True

    def test_qualified_rate_check_when_enabled(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        policy["brands"]["fulldigital"]["pipeline_quality_minimum"]["enabled_qualified_rate"] = True
        m = self._make_fd(qualified_rate=0.10)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is False
        assert "qualified_rate=0.1" in reason

    def test_qualified_rate_passes_when_high(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_quality_minimum
        policy["brands"]["fulldigital"]["pipeline_quality_minimum"]["enabled_qualified_rate"] = True
        m = self._make_fd(qualified_rate=0.50)
        passes, reason = passes_pipeline_quality_minimum(m, policy)
        assert passes is True

    # ── Integration: PQM blocks scale before close-rate gate ──

    def test_pqm_blocks_scale_to_hold(self, policy):
        """If pipeline quality minimum not met, scale → hold (insufficient signal)."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(calls_observed=5, pipeline_conversions=3)
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"
        assert block is not None
        assert block["gate_stage"] == "pipeline_quality_minimum"
        assert gated["detail"]["reason"] == "pipeline_quality_minimum_not_met"

    def test_pqm_does_not_block_kill(self, policy):
        """Kill decisions pass through regardless of PQM."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(calls_observed=0, pipeline_conversions=0)
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "pause", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "pause"
        assert block is None

    def test_pqm_does_not_block_hold(self, policy):
        """Hold decisions pass through regardless of PQM."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(calls_observed=0, pipeline_conversions=0)
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "hold", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"
        assert block is None

    # ── Hard fail close rate ──

    def test_hard_fail_close_rate_escalates_to_pause(self, policy):
        """When close rate is catastrophically low (<= hard_fail), escalate to pause."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=25, pipeline_conversions=30,
            revenue_conversions=0, close_rate=0.0, spend_usd=100,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "pause"
        assert block is not None
        assert block["gate_stage"] == "close_rate_hard_fail"
        assert gated["detail"]["reason"] == "quality_gate_hard_fail"

    def test_hard_fail_at_boundary(self, policy):
        """Close rate exactly at hard_fail_close_rate (0.02) triggers hard fail."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=25, pipeline_conversions=50,
            revenue_conversions=1, close_rate=0.02, spend_usd=100,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "pause"
        assert block["gate_stage"] == "close_rate_hard_fail"

    def test_normal_close_rate_gate_above_hard_fail(self, policy):
        """Close rate above hard_fail but below close_rate_min gets normal block_scale."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=25, pipeline_conversions=30,
            revenue_conversions=1, close_rate=0.033, spend_usd=100,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"
        assert block is not None
        assert block["gate_stage"] == "close_rate"
        assert gated["detail"]["reason"] == "quality_gate_close_rate"

    def test_good_close_rate_scales_through(self, policy):
        """Combo with acceptable close rate passes both gates and scales."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=25, pipeline_conversions=30,
            revenue_conversions=3, close_rate=0.10, spend_usd=100,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "scale_budget"
        assert block is None

    # ── Reporting quality signals ──

    def test_fd_leaderboard_includes_quality_signals(self):
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        from packages.agencyu.marketing.reporting import render_daily_report
        m = ComboMetricsFD(
            combo_id="fd_qs", brand="fulldigital",
            impressions=5000, clicks=100, conversions=10,
            spend_usd=50, revenue_usd=200,
            ctr=2.0, cpm=10, frequency=1.0, cpa=5.0, roas=4.0,
            pipeline_conversions=10, revenue_conversions=2,
            pipeline_cpa=5.0, revenue_cpa=25.0, close_rate=0.20,
            bookings=8, application_submits=2,
            calls_observed=8, qualified_count=5,
            qualified_rate=0.50, avg_lead_score=72.0,
        )
        report = render_daily_report([m], [])
        lb = report["fulldigital_dual_conversion_leaderboard"]
        assert len(lb) == 1
        assert lb[0]["calls_observed"] == 8
        assert lb[0]["qualified_count"] == 5
        assert lb[0]["qualified_rate"] == 0.50
        assert lb[0]["avg_lead_score"] == 72.0

    # ── ComboMetricsFD new fields ──

    def test_combo_metrics_fd_quality_defaults(self):
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        m = ComboMetricsFD(
            combo_id="x", brand="fulldigital",
            impressions=0, clicks=0, conversions=0,
            spend_usd=0, revenue_usd=0,
            ctr=0, cpm=0, frequency=0, cpa=0, roas=0,
        )
        assert m.calls_observed == 0
        assert m.qualified_count == 0
        assert m.qualified_rate == 0.0
        assert m.avg_lead_score is None
        assert m.attended_calls == 0
        assert m.show_rate == 0.0


# ═══════════════════════════════════════════
# Pipeline Integrity (Show Rate Gate)
# ═══════════════════════════════════════════


class TestPipelineIntegrity:
    """Tests for Layer 3: show rate gate."""

    @pytest.fixture()
    def policy(self):
        return {
            "brands": {
                "fulldigital": {
                    "pipeline_quality_minimum": {
                        "enabled": True,
                        "min_calls_observed": 20,
                        "min_pipeline_conversions": 15,
                    },
                    "quality_gate": {
                        "enabled": True,
                        "min_pipeline_conversions": 20,
                        "close_rate_min": 0.05,
                        "min_spend_usd": 50,
                        "hard_fail_close_rate": 0.02,
                        "hard_fail_action": "pause",
                        "decision": "block_scale",
                        "hold_mode": {
                            "action": "hold",
                            "cap_daily_budget_usd": 10,
                        },
                    },
                    "pipeline_integrity": {
                        "enabled": True,
                        "min_show_rate": 0.60,
                        "min_bookings_for_show_eval": 15,
                    },
                },
            },
        }

    def _make_fd(self, **overrides):
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        defaults = dict(
            combo_id="fd_test", brand="fulldigital",
            impressions=10000, clicks=200, conversions=25,
            spend_usd=100, revenue_usd=500,
            ctr=2.0, cpm=10, frequency=1.0, cpa=4.0, roas=5.0,
            pipeline_conversions=25, revenue_conversions=2,
            pipeline_cpa=4.0, revenue_cpa=50.0, close_rate=0.08,
            bookings=20, application_submits=5,
            attended_calls=15, show_rate=0.75,
            calls_observed=25, qualified_count=10,
            qualified_rate=0.4, avg_lead_score=75.0,
        )
        defaults.update(overrides)
        return ComboMetricsFD(**defaults)

    # ── passes_pipeline_integrity ──

    def test_passes_when_show_rate_good(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_integrity
        m = self._make_fd(bookings=20, attended_calls=16, show_rate=0.80)
        passes, reason = passes_pipeline_integrity(m, policy)
        assert passes is True
        assert reason is None

    def test_fails_when_show_rate_low(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_integrity
        m = self._make_fd(bookings=20, attended_calls=8, show_rate=0.40)
        passes, reason = passes_pipeline_integrity(m, policy)
        assert passes is False
        assert "show_rate=0.40" in reason

    def test_passes_when_bookings_below_eval_threshold(self, policy):
        """Not enough bookings to evaluate — pass through."""
        from packages.agencyu.marketing.quality_gate import passes_pipeline_integrity
        m = self._make_fd(bookings=10, attended_calls=2, show_rate=0.20)
        passes, reason = passes_pipeline_integrity(m, policy)
        assert passes is True

    def test_passes_when_disabled(self, policy):
        from packages.agencyu.marketing.quality_gate import passes_pipeline_integrity
        policy["brands"]["fulldigital"]["pipeline_integrity"]["enabled"] = False
        m = self._make_fd(bookings=20, attended_calls=2, show_rate=0.10)
        passes, reason = passes_pipeline_integrity(m, policy)
        assert passes is True

    def test_boundary_at_min_show_rate(self, policy):
        """Exactly at min_show_rate (0.60) should pass."""
        from packages.agencyu.marketing.quality_gate import passes_pipeline_integrity
        m = self._make_fd(bookings=20, attended_calls=12, show_rate=0.60)
        passes, reason = passes_pipeline_integrity(m, policy)
        assert passes is True

    def test_just_below_min_show_rate(self, policy):
        """Just below 0.60 should fail."""
        from packages.agencyu.marketing.quality_gate import passes_pipeline_integrity
        m = self._make_fd(bookings=20, attended_calls=11, show_rate=0.55)
        passes, reason = passes_pipeline_integrity(m, policy)
        assert passes is False

    # ── Integration: show rate blocks scale via apply_quality_gate ──

    def test_show_rate_blocks_scale(self, policy):
        """Combo passes L1 (PQM) and L2 (close rate) but fails L3 (show rate)."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=25, pipeline_conversions=25,
            revenue_conversions=3, close_rate=0.12, spend_usd=100,
            bookings=20, attended_calls=8, show_rate=0.40,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"
        assert block is not None
        assert block["gate_stage"] == "pipeline_integrity"
        assert gated["detail"]["reason"] == "pipeline_integrity_low_show_rate"
        assert gated["detail"]["pipeline_integrity"]["show_rate"] == 0.40

    def test_all_three_layers_pass_scales(self, policy):
        """Combo passes all three layers — scales normally."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=25, pipeline_conversions=25,
            revenue_conversions=3, close_rate=0.12, spend_usd=100,
            bookings=20, attended_calls=16, show_rate=0.80,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "scale_budget"
        assert block is None

    def test_close_rate_blocks_before_show_rate(self, policy):
        """L2 (close rate) blocks before L3 (show rate) is evaluated."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=25, pipeline_conversions=25,
            revenue_conversions=0, close_rate=0.0, spend_usd=100,
            bookings=20, attended_calls=8, show_rate=0.40,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        # L2 hard-fail triggers first (close_rate=0.0 <= 0.02)
        assert gated["decision"] == "pause"
        assert block["gate_stage"] == "close_rate_hard_fail"

    def test_pqm_blocks_before_show_rate(self, policy):
        """L1 (PQM) blocks before L3 (show rate) is evaluated."""
        from packages.agencyu.marketing.quality_gate import apply_quality_gate
        m = self._make_fd(
            calls_observed=5, pipeline_conversions=3,
            bookings=20, attended_calls=4, show_rate=0.20,
        )
        action = {"combo_id": "fd_test", "brand": "fulldigital", "decision": "scale_budget", "detail": {}}
        gated, block = apply_quality_gate(action, m, policy)
        assert gated["decision"] == "hold"
        assert block["gate_stage"] == "pipeline_quality_minimum"

    # ── Reporting includes show rate ──

    def test_fd_leaderboard_includes_show_rate(self):
        from packages.agencyu.marketing.metrics_types import ComboMetricsFD
        from packages.agencyu.marketing.reporting import render_daily_report
        m = ComboMetricsFD(
            combo_id="fd_sr", brand="fulldigital",
            impressions=5000, clicks=100, conversions=10,
            spend_usd=50, revenue_usd=200,
            ctr=2.0, cpm=10, frequency=1.0, cpa=5.0, roas=4.0,
            pipeline_conversions=10, revenue_conversions=2,
            pipeline_cpa=5.0, revenue_cpa=25.0, close_rate=0.20,
            bookings=8, application_submits=2,
            attended_calls=6, show_rate=0.75,
        )
        report = render_daily_report([m], [])
        lb = report["fulldigital_dual_conversion_leaderboard"]
        assert len(lb) == 1
        assert lb[0]["attended_calls"] == 6
        assert lb[0]["show_rate"] == 0.75

    # ── Policy YAML ──

    def test_pipeline_integrity_config_in_policy(self):
        import yaml
        from pathlib import Path
        policy_path = Path(__file__).resolve().parent.parent / "packages" / "agencyu" / "config" / "experiment_policy.yaml"
        with open(policy_path) as f:
            policy = yaml.safe_load(f)
        pi = policy["brands"]["fulldigital"]["pipeline_integrity"]
        assert pi["enabled"] is True
        assert pi["min_show_rate"] == 0.60
        assert pi["min_bookings_for_show_eval"] == 15


# ═══════════════════════════════════════════
# Ledger Metrics (standardized call + revenue)
# ═══════════════════════════════════════════


class TestLedgerMetrics:
    def test_call_stats_showed_preferred(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        from packages.agencyu.marketing.ledger_metrics import LedgerMetrics

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("ch1", "fulldigital", "combo_x", {})
        ledger.append_event("ch1", "booking_complete", "ghl", {})
        ledger.append_event("ch1", "booking_complete", "ghl", {})
        ledger.append_event("ch1", "call_showed", "ghl", {})

        lm = LedgerMetrics(conn)
        stats = lm.get_calls_by_combo("fulldigital", "2020-01-01T00:00:00", "2030-12-31T23:59:59")
        assert "combo_x" in stats
        s = stats["combo_x"]
        assert s.calls_booked == 2
        assert s.calls_showed == 1
        # calls_observed prefers showed
        assert s.calls_observed == 1

    def test_call_stats_fallback_to_booked(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        from packages.agencyu.marketing.ledger_metrics import LedgerMetrics

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("ch2", "fulldigital", "combo_y", {})
        ledger.append_event("ch2", "booking_complete", "ghl", {})

        lm = LedgerMetrics(conn)
        stats = lm.get_calls_by_combo("fulldigital", "2020-01-01T00:00:00", "2030-12-31T23:59:59")
        s = stats["combo_y"]
        assert s.calls_showed == 0
        # fallback to booked
        assert s.calls_observed == 1

    def test_revenue_stats_net_of_refunds(self, conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        from packages.agencyu.marketing.ledger_metrics import LedgerMetrics

        ledger = AttributionLedger(conn)
        ledger.upsert_chain("ch3", "fulldigital", "combo_z", {})
        ledger.append_event("ch3", "checkout_paid", "stripe", {"amount_usd": 5000})
        ledger.append_event("ch3", "checkout_paid", "stripe", {"amount_usd": 3000})
        ledger.append_event("ch3", "refund_issued", "stripe", {"refund_amount_usd": 1000})

        lm = LedgerMetrics(conn)
        stats = lm.get_revenue_by_combo("fulldigital", "2020-01-01T00:00:00", "2030-12-31T23:59:59")
        s = stats["combo_z"]
        assert s.closes == 2
        assert s.gross_revenue_usd == pytest.approx(8000.0)
        assert s.refunds_usd == pytest.approx(1000.0)
        assert s.net_revenue_usd == pytest.approx(7000.0)

    def test_empty_ledger_returns_empty(self, conn):
        from packages.agencyu.marketing.ledger_metrics import LedgerMetrics
        lm = LedgerMetrics(conn)
        assert lm.get_calls_by_combo("fulldigital", "2020-01-01T00:00:00", "2030-12-31T23:59:59") == {}
        assert lm.get_revenue_by_combo("fulldigital", "2020-01-01T00:00:00", "2030-12-31T23:59:59") == {}


# ═══════════════════════════════════════════
# Revenue Forecast (Beta CI + scaling confidence)
# ═══════════════════════════════════════════


class TestRevenueForecast:
    def test_beta_ci_basic(self):
        from packages.agencyu.marketing.revenue_forecast import beta_ci
        unc = beta_ci(5, 50, iterations=500)
        assert 0.0 < unc.mean < 1.0
        assert unc.p05 < unc.mean < unc.p95
        assert unc.width == pytest.approx(unc.p95 - unc.p05)

    def test_beta_ci_high_close_rate(self):
        from packages.agencyu.marketing.revenue_forecast import beta_ci
        unc = beta_ci(45, 50, iterations=500)
        # High close rate = narrow CI
        assert unc.mean > 0.8
        assert unc.width < 0.20  # Monte Carlo variance; 500 iterations

    def test_beta_ci_zero_closes(self):
        from packages.agencyu.marketing.revenue_forecast import beta_ci
        unc = beta_ci(0, 30, iterations=500)
        assert unc.mean < 0.10

    def test_scaling_confidence_narrow_ci(self):
        from packages.agencyu.marketing.revenue_forecast import (
            CloseRateUncertainty, scaling_confidence_from_uncertainty,
        )
        narrow = CloseRateUncertainty(mean=0.10, p05=0.08, p95=0.12, width=0.04)
        conf = scaling_confidence_from_uncertainty(narrow, penalty_weight=0.35)
        assert conf > 0.90

    def test_scaling_confidence_wide_ci(self):
        from packages.agencyu.marketing.revenue_forecast import (
            CloseRateUncertainty, scaling_confidence_from_uncertainty,
        )
        wide = CloseRateUncertainty(mean=0.10, p05=0.01, p95=0.30, width=0.29)
        conf = scaling_confidence_from_uncertainty(wide, penalty_weight=0.35)
        assert conf < 0.70


# ═══════════════════════════════════════════
# Retention Score
# ═══════════════════════════════════════════


class TestRetentionScore:
    def test_low_retention(self):
        from packages.agencyu.marketing.retention_score import retention_multiplier
        result = retention_multiplier(0.08, low=0.12, high=0.22, penalty=0.65, bonus=1.15)
        assert result.band == "low"
        assert result.multiplier == 0.65

    def test_ok_retention(self):
        from packages.agencyu.marketing.retention_score import retention_multiplier
        result = retention_multiplier(0.18, low=0.12, high=0.22, penalty=0.65, bonus=1.15)
        assert result.band == "ok"
        assert result.multiplier == 1.0

    def test_high_retention(self):
        from packages.agencyu.marketing.retention_score import retention_multiplier
        result = retention_multiplier(0.30, low=0.12, high=0.22, penalty=0.65, bonus=1.15)
        assert result.band == "high"
        assert result.multiplier == 1.15


# ═══════════════════════════════════════════
# Setter Scoring
# ═══════════════════════════════════════════


class TestSetterScoring:
    def test_compute_setter_scores(self, conn):
        import json
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        from packages.agencyu.marketing.setter_scoring import compute_setter_scores

        ledger = AttributionLedger(conn)
        # Setter A: 10 calls, 5 closes (50% close rate)
        for i in range(10):
            cid = f"ch_sa_{i}"
            ledger.upsert_chain(cid, "fulldigital", f"combo_{i}", {})
            ledger.append_event(cid, "call_showed", "ghl", {"setter_id": "setter_a"})
        for i in range(5):
            cid = f"ch_sa_{i}"
            ledger.append_event(cid, "checkout_paid", "stripe", {"setter_id": "setter_a", "amount_usd": 1000})

        # Setter B: 10 calls, 1 close (10% close rate)
        for i in range(10):
            cid = f"ch_sb_{i}"
            ledger.upsert_chain(cid, "fulldigital", f"combo_{i+10}", {})
            ledger.append_event(cid, "call_showed", "ghl", {"setter_id": "setter_b"})
        ledger.append_event("ch_sb_0", "checkout_paid", "stripe", {"setter_id": "setter_b", "amount_usd": 500})

        scores = compute_setter_scores(
            conn, "fulldigital",
            "2020-01-01T00:00:00", "2030-12-31T23:59:59",
            min_calls=5,
        )
        assert "setter_a" in scores
        assert "setter_b" in scores
        assert scores["setter_a"].close_rate == pytest.approx(0.5)
        assert scores["setter_b"].close_rate == pytest.approx(0.1)
        # Setter A should have higher multiplier than B
        assert scores["setter_a"].multiplier > scores["setter_b"].multiplier

    def test_empty_returns_empty(self, conn):
        from packages.agencyu.marketing.setter_scoring import compute_setter_scores
        scores = compute_setter_scores(
            conn, "fulldigital",
            "2020-01-01T00:00:00", "2030-12-31T23:59:59",
        )
        assert scores == {}


# ═══════════════════════════════════════════
# Fatigue Detection
# ═══════════════════════════════════════════


class TestFatigueDetection:
    def test_no_fatigue_when_metrics_ok(self):
        from packages.agencyu.marketing.fatigue import detect_fatigue
        sig = detect_fatigue(
            frequency=1.5, ctr_now=0.02, ctr_prev=0.02,
            cpc_now=1.0, cpc_prev=1.0,
        )
        assert sig.fatigued is False
        assert sig.reasons == []

    def test_fatigue_with_two_signals(self):
        from packages.agencyu.marketing.fatigue import detect_fatigue
        sig = detect_fatigue(
            frequency=3.0,  # above threshold
            ctr_now=0.01, ctr_prev=0.02,  # 50% drop > 35%
            cpc_now=1.0, cpc_prev=1.0,
        )
        assert sig.fatigued is True
        assert "high_frequency" in sig.reasons
        assert "ctr_drop" in sig.reasons

    def test_single_signal_not_enough(self):
        from packages.agencyu.marketing.fatigue import detect_fatigue
        sig = detect_fatigue(
            frequency=3.0,  # only one signal
            ctr_now=0.02, ctr_prev=0.02,
            cpc_now=1.0, cpc_prev=1.0,
        )
        assert sig.fatigued is False
        assert "high_frequency" in sig.reasons

    def test_all_three_signals(self):
        from packages.agencyu.marketing.fatigue import detect_fatigue
        sig = detect_fatigue(
            frequency=3.5,
            ctr_now=0.005, ctr_prev=0.02,  # 75% drop
            cpc_now=2.0, cpc_prev=1.0,     # 100% increase
        )
        assert sig.fatigued is True
        assert len(sig.reasons) == 3


# ═══════════════════════════════════════════
# CAC Payback Gate
# ═══════════════════════════════════════════


class TestPaybackGate:
    def test_immediate_payback(self):
        from packages.agencyu.marketing.payback import payback_gate_one_time
        result = payback_gate_one_time(
            cac=200, net_revenue=5000, gross_margin=0.70,
        )
        assert result.ok is True
        assert result.payback_days == 0.0
        assert result.reason == "immediate_payback"

    def test_payback_fails_when_margin_below_cac(self):
        from packages.agencyu.marketing.payback import payback_gate_one_time
        result = payback_gate_one_time(
            cac=5000, net_revenue=100, gross_margin=0.70,
        )
        assert result.ok is False

    def test_no_spend_always_ok(self):
        from packages.agencyu.marketing.payback import payback_gate_one_time
        result = payback_gate_one_time(
            cac=0, net_revenue=0, gross_margin=0.70,
        )
        assert result.ok is True
        assert result.reason == "no_spend"

    def test_zero_revenue(self):
        from packages.agencyu.marketing.payback import payback_gate_one_time
        result = payback_gate_one_time(
            cac=500, net_revenue=0, gross_margin=0.70,
        )
        assert result.ok is False
        assert result.reason == "zero_margin"

    def test_subscription_payback(self):
        from packages.agencyu.marketing.payback import payback_gate_subscription
        result = payback_gate_subscription(
            cac=100, ltv_estimate=500, gross_margin=0.80,
            horizon_days=90, max_payback_days=45,
        )
        assert result.ok is True
        assert result.payback_days < 45

    def test_subscription_payback_too_long(self):
        from packages.agencyu.marketing.payback import payback_gate_subscription
        result = payback_gate_subscription(
            cac=1000, ltv_estimate=100, gross_margin=0.80,
            horizon_days=90, max_payback_days=45,
        )
        assert result.ok is False
        assert result.reason == "payback_exceeds_horizon"


# ═══════════════════════════════════════════
# Policy YAML — Advanced Signals Config
# ═══════════════════════════════════════════


class TestAdvancedSignalsConfig:
    def test_all_advanced_signal_sections_present(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        assert "forecasting" in policy
        assert policy["forecasting"]["close_rate_volatility"]["enabled"] is True
        assert "content_retention" in policy
        assert "setter_scoring" in policy
        assert "angle_fatigue" in policy
        assert policy["angle_fatigue"]["enabled"] is True
        assert "payback" in policy
        assert policy["payback"]["enabled"] is True

    def test_payback_brand_margins(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        assert policy["payback"]["cutmv"]["gross_margin"] == 0.80
        assert policy["payback"]["fulldigital"]["gross_margin"] == 0.70
        assert policy["payback"]["cutmv"]["max_payback_days"] == 45
        assert policy["payback"]["fulldigital"]["max_payback_days"] == 30

    def test_angle_fatigue_defaults(self):
        import yaml
        with open(POLICY_PATH) as f:
            policy = yaml.safe_load(f)
        af = policy["angle_fatigue"]
        assert af["min_signals"] == 2
        assert af["action"] == "rotate_creative"
        assert af["frequency_threshold"] == 2.8


# ═══════════════════════════════════════════
# Brain Advanced Signals Integration
# ═══════════════════════════════════════════


class TestBrainAdvancedSignals:
    def test_advanced_signals_in_daily_report(self, conn):
        """run_experiment_policy_daily should include advanced_signals in report."""
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        from unittest.mock import patch

        with patch(
            "packages.agencyu.marketing.brain.aggregate_combo_metrics_contract",
            return_value=[],
        ):
            result = run_experiment_policy_daily(
                conn=conn, safe_mode=True, write_lock=False,
            )

        assert "advanced_signals" in result["report"]
        signals = result["report"]["advanced_signals"]
        assert "fatigue_rotations" in signals
        assert "volatility_downgrades" in signals
        assert "payback_blocks" in signals

    def test_traces_in_daily_report(self, conn):
        """run_experiment_policy_daily should include traces in result."""
        from packages.agencyu.marketing.brain import run_experiment_policy_daily
        from unittest.mock import patch

        with patch(
            "packages.agencyu.marketing.brain.aggregate_combo_metrics_contract",
            return_value=[],
        ):
            result = run_experiment_policy_daily(
                conn=conn, safe_mode=True, write_lock=False,
            )

        assert "traces" in result
        assert isinstance(result["traces"], list)


# ═══════════════════════════════════════════
# Ledger Normalizer + Writer + Chain Latest
# ═══════════════════════════════════════════


def _apply_migration_025(c):
    """Apply migration 025 to an in-memory SQLite database."""
    from pathlib import Path
    migration_path = Path(__file__).resolve().parent.parent / "packages" / "agencyu" / "migrations" / "025_ledger_enrichment.sql"
    sql = migration_path.read_text()
    # Strip comment-only lines, then split on semicolons
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    cleaned = "\n".join(lines)
    for stmt in cleaned.split(";"):
        stmt = stmt.strip()
        if stmt:
            try:
                c.execute(stmt)
            except Exception:
                pass  # ALTER TABLE may fail if column exists
    c.commit()


@pytest.fixture()
def ledger_conn():
    """Connection with base schema, attribution tables, and migration 025 applied."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_schema(c)
    # Create attribution tables (normally done by AttributionLedger.__init__)
    from packages.agencyu.marketing.attribution_ledger import AttributionLedger
    AttributionLedger(c)
    _apply_migration_025(c)
    return c


class TestEventNormalizer:
    def test_normalize_known_stage(self, ledger_conn):
        from packages.agencyu.ledger.normalizer import normalize_event
        ev = normalize_event(
            ledger_conn,
            chain_id="chain_1",
            stage="appointmentScheduled",
            source="ghl",
            ts="2026-03-01T00:00:00Z",
        )
        assert ev.normalized_stage == "booking_complete"
        assert ev.stage == "appointmentScheduled"
        assert ev.idempotency_key  # non-empty

    def test_normalize_unknown_stage_passthrough(self, ledger_conn):
        from packages.agencyu.ledger.normalizer import normalize_event
        ev = normalize_event(
            ledger_conn,
            chain_id="chain_1",
            stage="custom_weird_stage",
            source="ghl",
            ts="2026-03-01T00:00:00Z",
        )
        assert ev.normalized_stage == "custom_weird_stage"

    def test_idempotency_key_deterministic(self):
        from packages.agencyu.ledger.normalizer import make_idempotency_key
        k1 = make_idempotency_key(
            chain_id="c1", stage="booking_complete", source="ghl",
            ts="2026-03-01T00:00:00Z", payload={"a": 1},
        )
        k2 = make_idempotency_key(
            chain_id="c1", stage="booking_complete", source="ghl",
            ts="2026-03-01T00:00:00Z", payload={"a": 1},
        )
        assert k1 == k2

    def test_idempotency_key_differs_on_payload(self):
        from packages.agencyu.ledger.normalizer import make_idempotency_key
        k1 = make_idempotency_key(
            chain_id="c1", stage="s", source="ghl",
            ts="2026-03-01T00:00:00Z", payload={"a": 1},
        )
        k2 = make_idempotency_key(
            chain_id="c1", stage="s", source="ghl",
            ts="2026-03-01T00:00:00Z", payload={"a": 2},
        )
        assert k1 != k2

    def test_stripe_refund_normalization(self, ledger_conn):
        from packages.agencyu.ledger.normalizer import normalize_event
        ev = normalize_event(
            ledger_conn,
            chain_id="chain_1",
            stage="charge.refunded",
            source="stripe",
            ts="2026-03-01T00:00:00Z",
        )
        assert ev.normalized_stage == "refund_issued"


class TestLedgerWriter:
    def test_insert_event(self, ledger_conn):
        from packages.agencyu.ledger.normalizer import normalize_event
        from packages.agencyu.ledger.writer import LedgerWriter
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        # Create chain first
        ledger = AttributionLedger(ledger_conn)
        ledger.upsert_chain("chain_1", "fulldigital", "combo_1", {})

        ev = normalize_event(
            ledger_conn,
            chain_id="chain_1",
            stage="booking_complete",
            source="ghl",
            ts="2026-03-01T00:00:00Z",
            payload={"setter_id": "setter_1"},
        )
        writer = LedgerWriter(ledger_conn)
        assert writer.insert_event(ev) is True

        # Verify event was written
        row = ledger_conn.execute(
            "SELECT * FROM attribution_events WHERE chain_id='chain_1'"
        ).fetchone()
        assert row is not None
        assert row["normalized_stage"] == "booking_complete"

    def test_duplicate_rejected(self, ledger_conn):
        from packages.agencyu.ledger.normalizer import normalize_event
        from packages.agencyu.ledger.writer import LedgerWriter
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(ledger_conn)
        ledger.upsert_chain("chain_1", "fulldigital", "combo_1", {})

        ev = normalize_event(
            ledger_conn,
            chain_id="chain_1",
            stage="booking_complete",
            source="ghl",
            ts="2026-03-01T00:00:00Z",
        )
        writer = LedgerWriter(ledger_conn)
        assert writer.insert_event(ev) is True
        assert writer.insert_event(ev) is False  # duplicate

        # Only one row
        count = ledger_conn.execute(
            "SELECT COUNT(*) FROM attribution_events WHERE chain_id='chain_1'"
        ).fetchone()[0]
        assert count == 1


class TestChainLatest:
    def test_upsert_creates_row(self, ledger_conn):
        from packages.agencyu.ledger.chain_latest import upsert_chain_latest

        upsert_chain_latest(
            ledger_conn,
            chain_id="chain_1",
            brand="fulldigital",
            combo_id="combo_1",
            stage="booking_complete",
            ts="2026-03-01T00:00:00Z",
        )

        row = ledger_conn.execute(
            "SELECT * FROM mv_chain_latest WHERE chain_id='chain_1'"
        ).fetchone()
        assert row is not None
        assert row["latest_stage"] == "booking_complete"
        assert row["has_showed"] == 0
        assert row["has_closed"] == 0

    def test_upsert_updates_flags(self, ledger_conn):
        from packages.agencyu.ledger.chain_latest import upsert_chain_latest

        upsert_chain_latest(
            ledger_conn,
            chain_id="chain_1",
            brand="fulldigital",
            combo_id="combo_1",
            stage="booking_complete",
            ts="2026-03-01T00:00:00Z",
        )
        upsert_chain_latest(
            ledger_conn,
            chain_id="chain_1",
            brand="fulldigital",
            combo_id="combo_1",
            stage="call_showed",
            ts="2026-03-01T01:00:00Z",
        )

        row = ledger_conn.execute(
            "SELECT * FROM mv_chain_latest WHERE chain_id='chain_1'"
        ).fetchone()
        assert row["latest_stage"] == "call_showed"
        assert row["has_showed"] == 1
        assert row["total_events"] == 2

    def test_upsert_checkout_paid_sets_closed(self, ledger_conn):
        from packages.agencyu.ledger.chain_latest import upsert_chain_latest

        upsert_chain_latest(
            ledger_conn,
            chain_id="chain_1",
            brand="cutmv",
            combo_id="combo_1",
            stage="checkout_paid",
            ts="2026-03-01T00:00:00Z",
        )

        row = ledger_conn.execute(
            "SELECT * FROM mv_chain_latest WHERE chain_id='chain_1'"
        ).fetchone()
        assert row["has_closed"] == 1


# ═══════════════════════════════════════════
# Rollup Refresh Job
# ═══════════════════════════════════════════


class TestRollupRefresh:
    def test_refresh_mv_combo_daily(self, ledger_conn):
        from packages.agencyu.jobs.refresh_mv_combo_daily import refresh_mv_combo_daily
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger

        ledger = AttributionLedger(ledger_conn)
        ledger.upsert_chain("chain_1", "fulldigital", "combo_1", {})
        ledger.append_event("chain_1", "booking_complete", "ghl", {"setter_id": "s1"})
        ledger.append_event("chain_1", "checkout_paid", "stripe", {"amount_usd": 500.0})

        result = refresh_mv_combo_daily(ledger_conn)
        assert result["ok"] is True
        assert result["rows"] >= 1

        row = ledger_conn.execute(
            "SELECT * FROM mv_combo_daily WHERE combo_id='combo_1'"
        ).fetchone()
        assert row is not None
        assert row["calls_booked"] >= 1
        assert row["closes"] >= 1

    def test_refresh_mv_setter_daily(self, ledger_conn):
        from packages.agencyu.jobs.refresh_mv_combo_daily import refresh_mv_setter_daily
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        import json

        ledger = AttributionLedger(ledger_conn)
        ledger.upsert_chain("chain_1", "fulldigital", "combo_1", {})

        # Insert event with setter_id in payload
        ledger_conn.execute(
            """INSERT INTO attribution_events (chain_id, ts, stage, source, payload_json)
            VALUES (?, ?, ?, ?, ?)""",
            ("chain_1", "2026-03-01T00:00:00Z", "call_showed", "ghl",
             json.dumps({"setter_id": "setter_abc"})),
        )
        ledger_conn.commit()

        result = refresh_mv_setter_daily(ledger_conn)
        assert result["ok"] is True


# ═══════════════════════════════════════════
# Meta Retention Ingestion
# ═══════════════════════════════════════════


class TestMetaRetention:
    def test_ingest_creative_retention(self, ledger_conn):
        from packages.agencyu.integrations.meta_retention import (
            CreativeRetentionRow,
            ingest_creative_retention,
        )

        rows = [
            CreativeRetentionRow(
                creative_id="cr_1", brand="fulldigital", day="2026-03-01",
                impressions=5000, thruplay_count=1100, thruplay_rate=0.22,
                view_3s_count=3000, view_3s_rate=0.60, avg_watch_pct=0.45,
            ),
        ]
        count = ingest_creative_retention(ledger_conn, rows)
        assert count == 1

        row = ledger_conn.execute(
            "SELECT * FROM mv_creative_daily WHERE creative_id='cr_1'"
        ).fetchone()
        assert row is not None
        assert row["thruplay_rate"] == pytest.approx(0.22)

    def test_fetch_skeleton(self, ledger_conn):
        from packages.agencyu.integrations.meta_retention import (
            fetch_and_ingest_meta_retention,
        )
        result = fetch_and_ingest_meta_retention(
            ledger_conn, "fulldigital", "2026-03-01", "2026-03-05"
        )
        assert result["skeleton"] is True
        assert result["rows_ingested"] == 0


# ═══════════════════════════════════════════
# Policy Trace
# ═══════════════════════════════════════════


class TestPolicyTrace:
    def test_decision_trace_to_dict(self):
        from packages.agencyu.marketing.policy_trace import DecisionTrace

        t = DecisionTrace(
            combo_id="combo_1", brand="fulldigital", final_decision="hold"
        )
        t.add_step("quality_gate_l2", "block", close_rate=0.02, min=0.05)
        t.add_step("fatigue_b4", "pass")

        d = t.to_dict()
        assert d["combo_id"] == "combo_1"
        assert len(d["steps"]) == 2
        assert d["steps"][0]["gate"] == "quality_gate_l2"
        assert d["steps"][0]["result"] == "block"
        assert d["steps"][0]["detail"]["close_rate"] == 0.02

    def test_trace_step_structure(self):
        from packages.agencyu.marketing.policy_trace import TraceStep

        step = TraceStep(gate="payback_b5", result="block", detail={"days": 90})
        assert step.gate == "payback_b5"
        assert step.detail["days"] == 90


# ═══════════════════════════════════════════
# Policy Debug Explain
# ═══════════════════════════════════════════


class TestPolicyDebugExplain:
    def test_no_chains_returns_error(self, ledger_conn):
        from packages.agencyu.marketing.debug import policy_debug_explain

        result = policy_debug_explain("nonexistent_combo", conn=ledger_conn)
        assert result["error"] == "no_chains_found"
        assert "No attribution chains found" in result["explanation"][0]

    def test_explain_with_chain(self, ledger_conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        from packages.agencyu.marketing.debug import policy_debug_explain

        ledger = AttributionLedger(ledger_conn)
        ledger.upsert_chain("chain_1", "fulldigital", "combo_1", {})
        ledger.append_event("chain_1", "booking_complete", "ghl", {})
        ledger.append_event("chain_1", "checkout_paid", "stripe", {"amount_usd": 500.0})

        result = policy_debug_explain("combo_1", conn=ledger_conn)
        assert result["combo_id"] == "combo_1"
        assert result["brand"] == "fulldigital"
        assert "trace" in result
        assert "explanation" in result
        assert len(result["explanation"]) > 3  # Has multiple lines

    def test_explain_has_trace_steps(self, ledger_conn):
        from packages.agencyu.marketing.attribution_ledger import AttributionLedger
        from packages.agencyu.marketing.debug import policy_debug_explain

        ledger = AttributionLedger(ledger_conn)
        ledger.upsert_chain("chain_1", "cutmv", "combo_1", {})

        result = policy_debug_explain("combo_1", conn=ledger_conn)
        trace = result["trace"]
        assert len(trace["steps"]) >= 1
        assert trace["input_metrics"]["chains"] == 1


# ═══════════════════════════════════════════
# Migration 025 Schema
# ═══════════════════════════════════════════


class TestMigration025Schema:
    def test_normalization_rules_seeded(self, ledger_conn):
        """Migration should seed canonical normalization rules."""
        rows = ledger_conn.execute(
            "SELECT COUNT(*) FROM event_normalization_rules"
        ).fetchone()
        assert rows[0] >= 10  # At least 10 seed rules

    def test_mv_combo_daily_table_exists(self, ledger_conn):
        ledger_conn.execute("SELECT * FROM mv_combo_daily LIMIT 1")

    def test_mv_setter_daily_table_exists(self, ledger_conn):
        ledger_conn.execute("SELECT * FROM mv_setter_daily LIMIT 1")

    def test_mv_creative_daily_table_exists(self, ledger_conn):
        ledger_conn.execute("SELECT * FROM mv_creative_daily LIMIT 1")

    def test_mv_chain_latest_table_exists(self, ledger_conn):
        ledger_conn.execute("SELECT * FROM mv_chain_latest LIMIT 1")

    def test_normalization_rules_lookup(self, ledger_conn):
        row = ledger_conn.execute(
            "SELECT normalized_stage FROM event_normalization_rules "
            "WHERE source='ghl' AND raw_stage='appointmentScheduled'"
        ).fetchone()
        assert row is not None
        assert row[0] == "booking_complete"

    def test_stripe_refund_rule(self, ledger_conn):
        row = ledger_conn.execute(
            "SELECT normalized_stage FROM event_normalization_rules "
            "WHERE source='stripe' AND raw_stage='charge.refunded'"
        ).fetchone()
        assert row is not None
        assert row[0] == "refund_issued"
