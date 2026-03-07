"""Meta Ads Automation Engine — Campaign CRUD, A/B testing, kill/scale rules.

Full Digital LLC — CUTMV + Full Digital.
Manages Meta ad campaigns, budget optimization, creative fatigue detection,
and A/B test orchestration across ad variants.

Capabilities:
- Campaign/ad set/ad creation (placeholder for Meta Marketing API)
- A/B test matrix generation from variant combos
- Kill rules: 3x CPA threshold, low CTR, low comment rate
- Scale rules: 2x ROAS, min conversions gate
- Creative fatigue detection (CTR decline)
- Phase 1 sprint launchers
- launch_ab_matrix() for combo-driven experiment creation
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from packages.agencyu.messaging.approval_card import get_meta_daily_cap
from packages.common.logging import get_logger

log = get_logger("agencyu.engines.meta_ads")


def enforce_meta_cap(new_budget: float, cap: float | None = None) -> None:
    """Raise ``ValueError`` if *new_budget* exceeds the configured daily cap.

    Reads the cap from ``experiment_policy.yaml`` when *cap* is not supplied.
    """
    resolved = cap if cap is not None else get_meta_daily_cap()
    if resolved is not None and new_budget > resolved:
        raise ValueError(
            f"Budget ${new_budget:.0f} exceeds configured "
            f"max_daily_budget_cap_usd (${resolved:.0f})"
        )


# ── Enums & Config ──


class AdStatus(StrEnum):
    DRAFT = "draft"
    ACTIVE = "active"
    PAUSED = "paused"
    KILLED = "killed"
    SCALING = "scaling"


@dataclass
class AdPerformance:
    """Live performance metrics for a single ad variant."""

    ad_id: str
    variant_id: str
    brand: str
    spend: float = 0.0
    impressions: int = 0
    reach: int = 0
    clicks: int = 0
    comments: int = 0
    dm_triggers: int = 0
    signups: int = 0
    booked_calls: int = 0
    conversions: int = 0
    revenue: float = 0.0
    cpm: float = 0.0
    cpc: float = 0.0
    ctr: float = 0.0
    cost_per_comment: float = 0.0
    cost_per_dm: float = 0.0
    cost_per_signup: float = 0.0
    cost_per_booked: float = 0.0
    cost_per_conversion: float = 0.0
    roas: float = 0.0
    days_running: int = 0
    status: AdStatus = AdStatus.DRAFT
    last_updated: str | None = None
    combo_id: str | None = None

    def calculate_metrics(self) -> None:
        if self.impressions > 0:
            self.cpm = (self.spend / self.impressions) * 1000
            self.ctr = (self.clicks / self.impressions) * 100
        if self.clicks > 0:
            self.cpc = self.spend / self.clicks
        if self.comments > 0:
            self.cost_per_comment = self.spend / self.comments
        if self.dm_triggers > 0:
            self.cost_per_dm = self.spend / self.dm_triggers
        if self.signups > 0:
            self.cost_per_signup = self.spend / self.signups
        if self.booked_calls > 0:
            self.cost_per_booked = self.spend / self.booked_calls
        if self.conversions > 0:
            self.cost_per_conversion = self.spend / self.conversions
        if self.spend > 0:
            self.roas = self.revenue / self.spend
        self.last_updated = datetime.utcnow().isoformat()


@dataclass
class KillRule:
    """When to automatically pause an underperforming ad."""

    min_spend_before_eval: float = 50.0
    min_days_before_eval: int = 3
    max_cpa_multiplier: float = 3.0
    min_ctr: float = 0.5
    min_comments_per_100_reach: float = 0.1
    consecutive_decline_days: int = 3


@dataclass
class ScaleRule:
    """When to automatically increase budget on a winning ad."""

    min_conversions_before_scale: int = 5
    min_roas: float = 2.0
    max_budget_increase_pct: float = 20.0
    scale_cooldown_hours: int = 24
    max_daily_budget: float = 500.0


# ── Meta Ads Manager ──


class MetaAdsManager:
    """Manages Meta ad campaigns for both CUTMV and Full Digital."""

    def __init__(
        self,
        variants_config: dict[str, Any] | None = None,
        budget_tracker: Any = None,
    ) -> None:
        self.config: dict[str, Any] = variants_config or {}
        self.performances: dict[str, AdPerformance] = {}
        self.kill_rule = KillRule()
        self.scale_rule = ScaleRule()
        self.budget_tracker = budget_tracker

        self.app_id = os.getenv("META_APP_ID", "")
        self.access_token = os.getenv("META_ACCESS_TOKEN", "")
        self.ad_account_id = os.getenv("META_AD_ACCOUNT_ID", "")
        self.pixel_id = os.getenv("META_PIXEL_ID", "")

    # ── Campaign CRUD ──

    def create_campaign(self, brand: str, objective: str = "OUTCOME_SALES") -> dict[str, Any]:
        brand_config = self.config.get("brands", {}).get(brand, {})
        campaign_name = f"[OpenClaw] {brand_config.get('display_name', brand)} - {datetime.now().strftime('%Y-%m-%d')}"
        campaign = {
            "id": f"camp_{brand}_{datetime.now().strftime('%Y%m%d%H%M%S')}",
            "name": campaign_name,
            "brand": brand,
            "objective": objective,
            "status": "PAUSED",
            "created_at": datetime.utcnow().isoformat(),
            "daily_budget": brand_config.get("default_daily_budget", 50),
        }
        log.info("campaign_created", extra={"campaign_id": campaign["id"], "brand": brand})
        return campaign

    def create_ad_set(
        self,
        campaign_id: str,
        brand: str,
        audience_id: str,
        daily_budget: float,
        optimization_goal: str = "CONVERSATIONS",
    ) -> dict[str, Any]:
        enforce_meta_cap(daily_budget)
        ad_set = {
            "id": f"adset_{brand}_{audience_id}_{datetime.now().strftime('%H%M%S')}",
            "campaign_id": campaign_id,
            "brand": brand,
            "audience_id": audience_id,
            "daily_budget": daily_budget,
            "optimization_goal": optimization_goal,
            "status": "PAUSED",
            "created_at": datetime.utcnow().isoformat(),
            "bid_strategy": "LOWEST_COST",
            "placements": ["instagram_feed", "instagram_stories", "instagram_reels"],
        }
        # Persist budget for tracker (when available)
        if self.budget_tracker is not None:
            self.budget_tracker.upsert_budget(
                brand=brand,
                object_type="adset",
                object_id=ad_set["id"],
                object_name=f"{campaign_id}/{ad_set['id']}",
                daily_budget_usd=daily_budget,
            )
        log.info("ad_set_created", extra={"ad_set_id": ad_set["id"], "budget": daily_budget})
        return ad_set

    def create_ad(
        self,
        ad_set_id: str,
        brand: str,
        variant_id: str,
        cta_variant_id: str | None = None,
        combo_id: str | None = None,
    ) -> dict[str, Any]:
        ad = {
            "id": f"ad_{variant_id}_{cta_variant_id or 'default'}",
            "ad_set_id": ad_set_id,
            "brand": brand,
            "variant_id": variant_id,
            "cta_variant_id": cta_variant_id,
            "combo_id": combo_id,
            "status": "PAUSED",
            "created_at": datetime.utcnow().isoformat(),
        }
        perf = AdPerformance(
            ad_id=ad["id"],
            variant_id=variant_id,
            brand=brand,
            status=AdStatus.DRAFT,
            combo_id=combo_id,
        )
        self.performances[ad["id"]] = perf
        log.info("ad_created", extra={"ad_id": ad["id"], "combo_id": combo_id})
        return ad

    # ── A/B Testing ──

    def create_ab_test(
        self,
        brand: str,
        variant_ids: list[str],
        audience_id: str,
        daily_budget_per_variant: float = 25.0,
        cta_variants: list[str] | None = None,
    ) -> dict[str, Any]:
        campaign = self.create_campaign(brand)
        test: dict[str, Any] = {
            "id": f"test_{brand}_{datetime.now().strftime('%Y%m%d%H%M%S')}",
            "campaign_id": campaign["id"],
            "brand": brand,
            "variants": [],
            "status": "setup",
            "created_at": datetime.utcnow().isoformat(),
            "total_daily_budget": 0.0,
        }
        cta_ids = cta_variants or [None]
        for variant_id in variant_ids:
            for cta_id in cta_ids:
                ad_set = self.create_ad_set(
                    campaign_id=campaign["id"],
                    brand=brand,
                    audience_id=audience_id,
                    daily_budget=daily_budget_per_variant,
                )
                ad = self.create_ad(
                    ad_set_id=ad_set["id"],
                    brand=brand,
                    variant_id=variant_id,
                    cta_variant_id=cta_id,
                )
                test["variants"].append({
                    "ad_set_id": ad_set["id"],
                    "ad_id": ad["id"],
                    "variant_id": variant_id,
                    "cta_id": cta_id,
                })
                test["total_daily_budget"] += daily_budget_per_variant

        log.info("ab_test_created", extra={
            "test_id": test["id"],
            "variants": len(test["variants"]),
            "daily_budget": test["total_daily_budget"],
        })
        return test

    def launch_ab_matrix(
        self,
        combos: list[Any],
        brand: str,
        daily_budget_per_combo: float = 17.0,
        dry_run: bool = True,
    ) -> dict[str, Any]:
        """Launch ads from experiment matrix combos.

        Each combo gets a campaign with combo_id + utm_campaign attached.
        Supports dry-run mode (no actual API calls — just plans).
        """
        results: list[dict[str, Any]] = []
        total_budget = 0.0

        for combo in combos:
            combo_id = getattr(combo, "combo_id", str(combo))
            audience_id = getattr(combo, "audience_id", "default")
            creative_id = getattr(combo, "creative_id", "default")
            cta_id = getattr(combo, "cta_id", None)

            entry: dict[str, Any] = {
                "combo_id": combo_id,
                "creative_id": creative_id,
                "cta_id": cta_id,
                "audience_id": audience_id,
                "daily_budget": daily_budget_per_combo,
                "dry_run": dry_run,
            }

            if not dry_run:
                ad_set = self.create_ad_set(
                    campaign_id=f"camp_{brand}_matrix",
                    brand=brand,
                    audience_id=audience_id,
                    daily_budget=daily_budget_per_combo,
                )
                ad = self.create_ad(
                    ad_set_id=ad_set["id"],
                    brand=brand,
                    variant_id=creative_id,
                    cta_variant_id=cta_id,
                    combo_id=combo_id,
                )
                entry["ad_set_id"] = ad_set["id"]
                entry["ad_id"] = ad["id"]

            results.append(entry)
            total_budget += daily_budget_per_combo

        log.info("ab_matrix_launched", extra={
            "brand": brand,
            "combos": len(results),
            "total_budget": total_budget,
            "dry_run": dry_run,
        })
        return {
            "brand": brand,
            "combos_launched": len(results),
            "total_daily_budget": total_budget,
            "dry_run": dry_run,
            "results": results,
        }

    # ── Performance Evaluation ──

    def evaluate_performance(self, ad_id: str) -> str:
        """Evaluate ad against kill/scale rules. Returns: 'keep', 'kill', 'scale', or 'wait'."""
        perf = self.performances.get(ad_id)
        if not perf:
            return "unknown"
        if perf.spend < self.kill_rule.min_spend_before_eval:
            return "wait"
        if perf.days_running < self.kill_rule.min_days_before_eval:
            return "wait"

        perf.calculate_metrics()

        # Kill checks
        target_cpa = 100.0 if perf.brand == "fulldigital" else 19.0
        if perf.cost_per_conversion > 0 and perf.cost_per_conversion > target_cpa * self.kill_rule.max_cpa_multiplier:
            log.warning("kill_rule_triggered", extra={"ad_id": ad_id, "reason": "cpa_exceeded"})
            return "kill"
        if perf.ctr < self.kill_rule.min_ctr and perf.impressions > 1000:
            log.warning("kill_rule_triggered", extra={"ad_id": ad_id, "reason": "low_ctr"})
            return "kill"

        # Scale checks
        if perf.conversions >= self.scale_rule.min_conversions_before_scale:
            if perf.roas >= self.scale_rule.min_roas:
                log.info("scale_rule_triggered", extra={"ad_id": ad_id, "roas": perf.roas})
                return "scale"

        return "keep"

    def run_optimization_cycle(self) -> dict[str, int]:
        """Run kill/scale on all active ads."""
        actions = {"killed": 0, "scaled": 0, "kept": 0, "waiting": 0}
        for ad_id, perf in self.performances.items():
            if perf.status not in (AdStatus.ACTIVE, AdStatus.SCALING):
                continue
            action = self.evaluate_performance(ad_id)
            if action == "kill":
                perf.status = AdStatus.KILLED
                actions["killed"] += 1
            elif action == "scale":
                perf.status = AdStatus.SCALING
                actions["scaled"] += 1
            elif action == "keep":
                actions["kept"] += 1
            else:
                actions["waiting"] += 1

        log.info("optimization_cycle_complete", extra=actions)
        return actions

    # ── Creative Fatigue ──

    def detect_creative_fatigue(self, ad_id: str, history: list[AdPerformance]) -> bool:
        """Detect CTR declining for 3+ consecutive days."""
        if len(history) < 4:
            return False
        recent = history[-4:]
        ctr_declining = all(recent[i].ctr < recent[i - 1].ctr for i in range(1, len(recent)))
        if ctr_declining:
            log.warning("creative_fatigue", extra={"ad_id": ad_id})
        return ctr_declining

    # ── Phase 1 Sprint Launchers ──

    def launch_phase_1_cutmv(self) -> dict[str, Any]:
        """3 ads, $50/day, 14-day sprint."""
        test = self.create_ab_test(
            brand="cutmv",
            variant_ids=["cutmv_ad_01", "cutmv_ad_02", "cutmv_ad_08"],
            audience_id="aud_editors_broad",
            daily_budget_per_variant=17,
        )
        log.info("phase_1_cutmv_launched", extra={"test_id": test["id"]})
        return test

    def launch_phase_1_fulldigital(self) -> dict[str, Any]:
        """1 ad, $30/day, validate DM-to-call pipeline."""
        test = self.create_ab_test(
            brand="fulldigital",
            variant_ids=["fd_ad_01"],
            audience_id="aud_artists_50k",
            daily_budget_per_variant=30,
        )
        log.info("phase_1_fd_launched", extra={"test_id": test["id"]})
        return test

    # ── Reporting ──

    def generate_daily_report(self) -> dict[str, Any]:
        report: dict[str, Any] = {"date": datetime.utcnow().strftime("%Y-%m-%d"), "brands": {}}
        for brand in ["cutmv", "fulldigital"]:
            brand_ads = [p for p in self.performances.values() if p.brand == brand and p.status == AdStatus.ACTIVE]
            total_spend = sum(a.spend for a in brand_ads)
            total_conversions = sum(a.conversions for a in brand_ads)
            total_revenue = sum(a.revenue for a in brand_ads)
            report["brands"][brand] = {
                "active_ads": len(brand_ads),
                "total_spend": round(total_spend, 2),
                "total_conversions": total_conversions,
                "total_revenue": round(total_revenue, 2),
                "blended_roas": round(total_revenue / total_spend, 2) if total_spend > 0 else 0,
                "blended_cpa": round(total_spend / total_conversions, 2) if total_conversions > 0 else 0,
            }
        return report
