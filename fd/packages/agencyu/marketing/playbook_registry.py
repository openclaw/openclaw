"""Playbook Registry — Modular funnel building blocks.

Defines composable funnel modules that can be mixed/matched for experiments.
Each module represents a stage in the funnel pipeline:
- Acquisition (Meta Ad → CTA → DM keyword)
- DM Flow (ManyChat flow → tags)
- Landing Stack (ClickFunnels path + pixel events)
- Checkout (Stripe checkout, offer intent)
- Nurture (pre-call/post-signup sequences)
- Retention (churn prevention, upsell)

Instances are referenced by experiments via the ExperimentMatrix.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Brand = Literal["cutmv", "fulldigital"]
Stage = Literal[
    "ad_impression", "ad_click", "ig_comment", "ig_dm_started", "dm_qualified",
    "vsl_optin", "vsl_watch", "application_submit", "booking_complete",
    "checkout_started", "checkout_paid", "onboarded",
]
ModuleKind = Literal["acquisition", "dm_flow", "landing_stack", "checkout", "nurture", "retention"]


@dataclass(frozen=True)
class FunnelModule:
    """Composable module definition. Referenced by experiments."""

    module_id: str
    brand: Brand
    kind: ModuleKind
    description: str
    stages_emitted: list[Stage]
    required_fields: list[str] = field(default_factory=list)
    metadata: dict[str, str] = field(default_factory=dict)


class PlaybookRegistry:
    """In-memory registry of funnel modules. Can be backed by YAML + drift-healed."""

    def __init__(self) -> None:
        self._modules: dict[str, FunnelModule] = {}

    def register(self, module: FunnelModule) -> None:
        if module.module_id in self._modules:
            raise ValueError(f"Duplicate module_id: {module.module_id}")
        self._modules[module.module_id] = module

    def get(self, module_id: str) -> FunnelModule:
        if module_id not in self._modules:
            raise KeyError(f"Module not found: {module_id}")
        return self._modules[module_id]

    def list_modules(self, brand: Brand | None = None, kind: ModuleKind | None = None) -> list[FunnelModule]:
        items = list(self._modules.values())
        if brand is not None:
            items = [m for m in items if m.brand == brand]
        if kind is not None:
            items = [m for m in items if m.kind == kind]
        return items

    def count(self) -> int:
        return len(self._modules)


def seed_default_modules(registry: PlaybookRegistry) -> None:
    """Seed the registry with the standard CUTMV + Full Digital funnel modules."""
    # CUTMV modules
    registry.register(FunnelModule(
        module_id="cutmv_acquisition",
        brand="cutmv",
        kind="acquisition",
        description="Meta comment-to-DM ads for CUTMV SaaS signups",
        stages_emitted=["ad_impression", "ad_click", "ig_comment"],
        required_fields=["creative_id", "cta_id", "audience_id"],
    ))
    registry.register(FunnelModule(
        module_id="cutmv_dm_flow",
        brand="cutmv",
        kind="dm_flow",
        description="ManyChat DM qualification → link delivery for CUTMV",
        stages_emitted=["ig_dm_started", "dm_qualified"],
        required_fields=["trigger_keyword", "dm_copy_id"],
    ))
    registry.register(FunnelModule(
        module_id="cutmv_landing_stack",
        brand="cutmv",
        kind="landing_stack",
        description="ClickFunnels opt-in → VSL → checkout (4 pages)",
        stages_emitted=["vsl_optin", "vsl_watch", "checkout_started"],
        required_fields=["funnel_id"],
    ))
    registry.register(FunnelModule(
        module_id="cutmv_checkout",
        brand="cutmv",
        kind="checkout",
        description="Stripe checkout for CUTMV plan selection",
        stages_emitted=["checkout_started", "checkout_paid"],
        required_fields=["offer_id"],
    ))
    registry.register(FunnelModule(
        module_id="cutmv_nurture",
        brand="cutmv",
        kind="nurture",
        description="Post-signup onboarding email sequence",
        stages_emitted=["onboarded"],
    ))

    # Full Digital modules
    registry.register(FunnelModule(
        module_id="fd_acquisition",
        brand="fulldigital",
        kind="acquisition",
        description="Meta comment-to-DM ads for Full Digital strategy calls",
        stages_emitted=["ad_impression", "ad_click", "ig_comment"],
        required_fields=["creative_id", "cta_id", "audience_id"],
    ))
    registry.register(FunnelModule(
        module_id="fd_dm_flow",
        brand="fulldigital",
        kind="dm_flow",
        description="ManyChat DM qualification → VSL link for Full Digital",
        stages_emitted=["ig_dm_started", "dm_qualified"],
        required_fields=["trigger_keyword", "dm_copy_id"],
    ))
    registry.register(FunnelModule(
        module_id="fd_landing_stack",
        brand="fulldigital",
        kind="landing_stack",
        description="ClickFunnels opt-in → VSL → application → booking (5 pages)",
        stages_emitted=["vsl_optin", "vsl_watch", "application_submit", "booking_complete"],
        required_fields=["funnel_id"],
    ))
    registry.register(FunnelModule(
        module_id="fd_nurture",
        brand="fulldigital",
        kind="nurture",
        description="Pre-call nurture sequence (email + SMS)",
        stages_emitted=["onboarded"],
    ))
    registry.register(FunnelModule(
        module_id="fd_retention",
        brand="fulldigital",
        kind="retention",
        description="Full Digital client retention + upsell triggers",
        stages_emitted=[],
    ))
