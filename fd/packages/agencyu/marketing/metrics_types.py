"""Shared metric types for the OpenClaw policy engine + reporting.

ComboMetrics is the stable base used by the policy engine's decision logic.
ComboMetricsFD extends it with Full Digital dual-conversion fields for
richer reporting without breaking any existing policy rules.

Dual conversion model (Full Digital):
  Pipeline: booking_complete + application_submit → lead quality + scheduling
  Revenue:  checkout_paid (Stripe)                → actual sales + LTV:CAC
  Close rate: revenue_conversions / pipeline_conversions
  Show rate:  attended_calls / bookings
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ComboMetrics:
    """Generic combo metrics used by the policy engine.

    IMPORTANT: Keep this stable — the policy engine's hold/kill/scale/fatigue
    rules operate on these fields. Do not rename or remove any.
    """

    combo_id: str
    brand: str
    impressions: int
    clicks: int
    conversions: int  # policy "primary" conversion count for the brand
    spend_usd: float
    revenue_usd: float
    ctr: float
    cpm: float
    frequency: float
    cpa: float
    roas: float
    pipeline_conversions: int = 0
    revenue_conversions: int = 0


@dataclass
class ComboMetricsFD(ComboMetrics):
    """Full Digital specialization with dual-conversion analytics.

    Extends ComboMetrics so the policy engine still works (isinstance check passes).

    Core dual-conversion fields:
    - pipeline_cpa: spend / pipeline_conversions (cost per booked call / application)
    - revenue_cpa: spend / revenue_conversions (effective cost to close)
    - close_rate: revenue_conversions / pipeline_conversions (sales efficiency)
    - bookings: count of booking_complete events
    - application_submits: count of application_submit events

    Pipeline integrity fields:
    - attended_calls: count of call_attended events (calls actually taken)
    - show_rate: attended_calls / bookings (measures booking quality)

    Quality signal fields (used by pipeline_quality_minimum gate):
    - calls_observed: total booked calls actually observed (may differ from bookings
      if some bookings haven't reached the call stage yet)
    - qualified_count: pipeline conversions tagged as qualified
    - qualified_rate: qualified_count / pipeline_conversions
    - avg_lead_score: average GHL/application lead score across pipeline conversions
    """

    pipeline_cpa: float = 0.0
    revenue_cpa: float = 0.0
    close_rate: float = 0.0
    bookings: int = 0
    application_submits: int = 0
    attended_calls: int = 0
    show_rate: float = 0.0
    calls_observed: int = 0
    qualified_count: int = 0
    qualified_rate: float = 0.0
    avg_lead_score: float | None = None
