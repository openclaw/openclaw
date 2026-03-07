"""ClickFunnels VSL Stack Integration — Programmatic funnel management.

Full Digital LLC — CUTMV + Full Digital.
Manages the ClickFunnels VSL funnel stack for both brands:
- CUTMV: 4-page self-serve (opt-in → demo VSL → checkout → onboarding)
- Full Digital: 5-page high-ticket (opt-in → 20-min VSL → application → Calendly → pre-call nurture)

Integration points:
- ClickFunnels 2.0 API (funnels, pages, contacts)
- ManyChat (tag sync on opt-in)
- Stripe (payment events for CUTMV)
- Calendly (booking events for Full Digital)
- Notion CRM (contact + deal sync)
- Meta Pixel (conversion events via Conversions API)
"""
from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.integrations.clickfunnels_vsl")


# ── Enums ──


class FunnelType(StrEnum):
    CUTMV_SELF_SERVE = "cutmv_self_serve"
    FULLDIGITAL_HIGH_TICKET = "fd_high_ticket"


class PageType(StrEnum):
    OPT_IN = "opt_in"
    VSL = "vsl"
    APPLICATION = "application"
    BOOKING = "booking"
    THANK_YOU = "thank_you"
    CHECKOUT = "checkout"


class VisitorStage(StrEnum):
    LANDED = "landed"
    OPTED_IN = "opted_in"
    WATCHING_VSL = "watching_vsl"
    VSL_25 = "vsl_25_percent"
    VSL_50 = "vsl_50_percent"
    VSL_75 = "vsl_75_percent"
    VSL_COMPLETE = "vsl_complete"
    CTA_CLICKED = "cta_clicked"
    APPLICATION_STARTED = "application_started"
    APPLICATION_SUBMITTED = "application_submitted"
    BOOKING_STARTED = "booking_started"
    BOOKING_CONFIRMED = "booking_confirmed"
    CHECKOUT_STARTED = "checkout_started"
    CHECKOUT_COMPLETE = "checkout_complete"
    THANK_YOU_REACHED = "thank_you_reached"


# ── Data Models ──


@dataclass
class FunnelPage:
    """A single page in a ClickFunnels funnel."""

    id: str
    funnel_id: str
    page_type: PageType
    name: str
    url_slug: str
    variant_id: str = "default"
    headline: str = ""
    subheadline: str = ""
    vsl_embed_url: str = ""
    cta_delay_seconds: int = 0
    cta_text: str = ""
    form_fields: list[str] = field(default_factory=list)
    calendly_url: str = ""
    redirect_url: str = ""
    meta_pixel_events: list[str] = field(default_factory=list)
    utm_passthrough: bool = True
    views: int = 0
    conversions: int = 0

    @property
    def conversion_rate(self) -> float:
        return (self.conversions / self.views * 100) if self.views > 0 else 0.0


@dataclass
class FunnelVisitor:
    """Tracks a visitor through the funnel with full attribution."""

    visitor_id: str
    funnel_id: str
    brand: str
    entered_at: datetime = field(default_factory=datetime.now)
    # Attribution
    utm_source: str = ""
    utm_medium: str = ""
    utm_campaign: str = ""
    utm_content: str = ""
    utm_term: str = ""
    manychat_id: str = ""
    ad_id: str = ""
    creative_variant: str = ""
    cta_variant: str = ""
    offer_variant: str = ""
    combo_id: str = ""
    # Journey
    stages_completed: list[VisitorStage] = field(default_factory=list)
    current_stage: VisitorStage = VisitorStage.LANDED
    # Contact info
    email: str = ""
    name: str = ""
    phone: str = ""
    role: str = ""
    # Application data (FD)
    monthly_listeners: str = ""
    current_revenue: str = ""
    biggest_challenge: str = ""
    investment_ready: str = ""
    # Outcome
    booked_call: bool = False
    booking_time: datetime | None = None
    signed_up: bool = False
    paid: bool = False
    deal_value: float = 0.0
    # VSL engagement
    vsl_watch_percent: float = 0.0
    vsl_watch_seconds: int = 0

    def advance_stage(self, stage: VisitorStage) -> None:
        if stage not in self.stages_completed:
            self.stages_completed.append(stage)
        self.current_stage = stage

    @property
    def full_attribution(self) -> dict[str, Any]:
        return {
            "visitor_id": self.visitor_id,
            "source": self.utm_source,
            "medium": self.utm_medium,
            "campaign": self.utm_campaign,
            "content": self.utm_content,
            "ad_id": self.ad_id,
            "creative_variant": self.creative_variant,
            "cta_variant": self.cta_variant,
            "offer_variant": self.offer_variant,
            "combo_id": self.combo_id,
            "manychat_id": self.manychat_id,
            "stages": [s.value for s in self.stages_completed],
            "outcome": "paid" if self.paid else "booked" if self.booked_call else "signed_up" if self.signed_up else "incomplete",
            "deal_value": self.deal_value,
        }


# ── ClickFunnels VSL Manager ──


class ClickFunnelsVSLManager:
    """Manages the ClickFunnels VSL stack for both brands."""

    def __init__(self) -> None:
        self.funnels: dict[str, dict[str, Any]] = {}
        self.visitors: dict[str, FunnelVisitor] = {}
        self.pages: dict[str, FunnelPage] = {}

    # ── Funnel Creation ──

    def create_cutmv_funnel(self, variant_config: dict[str, Any] | None = None) -> dict[str, Any]:
        """Build CUTMV VSL-to-signup funnel (4 pages)."""
        funnel_id = f"cutmv_vsl_{datetime.now().strftime('%Y%m%d')}"
        cfg = variant_config or {}

        pages = [
            FunnelPage(
                id=f"{funnel_id}_optin", funnel_id=funnel_id, page_type=PageType.OPT_IN,
                name="CUTMV — Free Trial Access", url_slug="cutmv-free",
                headline=cfg.get("optin_headline", "Turn One Music Video Into 15 Pieces of Content"),
                cta_text=cfg.get("optin_cta", "Get Free Access →"),
                form_fields=["email"], redirect_url=f"/{funnel_id}/watch",
                meta_pixel_events=["Lead", "ViewContent"],
            ),
            FunnelPage(
                id=f"{funnel_id}_vsl", funnel_id=funnel_id, page_type=PageType.VSL,
                name="CUTMV — See It In Action", url_slug="cutmv-watch",
                headline=cfg.get("vsl_headline", "Watch How CUTMV Works"),
                vsl_embed_url=cfg.get("vsl_url", ""),
                cta_delay_seconds=cfg.get("cta_delay", 180),
                cta_text=cfg.get("vsl_cta", "Start Your Free Trial →"),
                redirect_url=f"/{funnel_id}/signup",
                meta_pixel_events=["ViewContent"],
            ),
            FunnelPage(
                id=f"{funnel_id}_checkout", funnel_id=funnel_id, page_type=PageType.CHECKOUT,
                name="CUTMV — Choose Your Plan", url_slug="cutmv-signup",
                headline="Start Cutting Smarter Today",
                form_fields=["email", "name", "plan_selection"],
                redirect_url=f"/{funnel_id}/welcome",
                meta_pixel_events=["InitiateCheckout", "StartTrial"],
            ),
            FunnelPage(
                id=f"{funnel_id}_thankyou", funnel_id=funnel_id, page_type=PageType.THANK_YOU,
                name="CUTMV — Welcome", url_slug="cutmv-welcome",
                headline="You're In. Let's Make Your First Cut.",
                meta_pixel_events=["CompleteRegistration"],
            ),
        ]

        funnel = {
            "id": funnel_id, "type": FunnelType.CUTMV_SELF_SERVE,
            "brand": "cutmv", "pages": {p.page_type.value: p for p in pages},
            "created_at": datetime.now().isoformat(), "status": "draft",
        }
        self.funnels[funnel_id] = funnel
        for p in pages:
            self.pages[p.id] = p
        log.info("cutmv_funnel_created", extra={"funnel_id": funnel_id})
        return funnel

    def create_fulldigital_funnel(self, variant_config: dict[str, Any] | None = None) -> dict[str, Any]:
        """Build Full Digital high-ticket VSL funnel (5 pages)."""
        funnel_id = f"fd_vsl_{datetime.now().strftime('%Y%m%d')}"
        cfg = variant_config or {}

        pages = [
            FunnelPage(
                id=f"{funnel_id}_optin", funnel_id=funnel_id, page_type=PageType.OPT_IN,
                name="Full Digital — Free Rollout Strategy", url_slug="fd-strategy",
                headline=cfg.get("optin_headline", "The Visual Strategy Behind Every #1 Album"),
                cta_text=cfg.get("optin_cta", "Watch The Free Training →"),
                form_fields=["email", "first_name"], redirect_url=f"/{funnel_id}/watch",
                meta_pixel_events=["Lead", "ViewContent"],
            ),
            FunnelPage(
                id=f"{funnel_id}_vsl", funnel_id=funnel_id, page_type=PageType.VSL,
                name="Full Digital — The Training", url_slug="fd-watch",
                vsl_embed_url=cfg.get("vsl_url", ""),
                cta_delay_seconds=cfg.get("cta_delay", 720),
                cta_text=cfg.get("vsl_cta", "Apply For A Free Strategy Session →"),
                redirect_url=f"/{funnel_id}/apply",
                meta_pixel_events=["ViewContent"],
            ),
            FunnelPage(
                id=f"{funnel_id}_application", funnel_id=funnel_id, page_type=PageType.APPLICATION,
                name="Full Digital — Application", url_slug="fd-apply",
                headline="Apply For Your Free Strategy Session",
                form_fields=[
                    "full_name", "email", "phone", "instagram_handle", "role",
                    "monthly_listeners", "releases_last_12mo", "generating_revenue",
                    "biggest_challenge", "investment_ready", "anything_else",
                ],
                redirect_url=f"/{funnel_id}/book",
                meta_pixel_events=["SubmitApplication"],
            ),
            FunnelPage(
                id=f"{funnel_id}_booking", funnel_id=funnel_id, page_type=PageType.BOOKING,
                name="Full Digital — Book Your Call", url_slug="fd-book",
                headline="Pick A Time That Works",
                calendly_url=cfg.get("calendly_url", "https://calendly.com/fulldigital/strategy"),
                redirect_url=f"/{funnel_id}/confirmed",
                meta_pixel_events=["Schedule"],
            ),
            FunnelPage(
                id=f"{funnel_id}_thankyou", funnel_id=funnel_id, page_type=PageType.THANK_YOU,
                name="Full Digital — You're Booked", url_slug="fd-confirmed",
                headline="You're Locked In.",
                meta_pixel_events=["CompleteRegistration"],
            ),
        ]

        funnel = {
            "id": funnel_id, "type": FunnelType.FULLDIGITAL_HIGH_TICKET,
            "brand": "fulldigital", "pages": {p.page_type.value: p for p in pages},
            "created_at": datetime.now().isoformat(), "status": "draft",
        }
        self.funnels[funnel_id] = funnel
        for p in pages:
            self.pages[p.id] = p
        log.info("fd_funnel_created", extra={"funnel_id": funnel_id})
        return funnel

    # ── Visitor Tracking ──

    def track_visitor(
        self,
        funnel_id: str,
        utm_params: dict[str, str] | None = None,
        manychat_id: str = "",
        combo_id: str = "",
    ) -> FunnelVisitor:
        utms = utm_params or {}
        visitor_id = hashlib.md5(
            f"{funnel_id}_{datetime.now().isoformat()}_{manychat_id}".encode()
        ).hexdigest()[:12]
        brand = self.funnels.get(funnel_id, {}).get("brand", "unknown")

        visitor = FunnelVisitor(
            visitor_id=visitor_id, funnel_id=funnel_id, brand=brand,
            utm_source=utms.get("utm_source", ""),
            utm_medium=utms.get("utm_medium", ""),
            utm_campaign=utms.get("utm_campaign", ""),
            utm_content=utms.get("utm_content", ""),
            utm_term=utms.get("utm_term", ""),
            manychat_id=manychat_id,
            ad_id=utms.get("ad_id", ""),
            creative_variant=utms.get("creative", ""),
            cta_variant=utms.get("cta", ""),
            offer_variant=utms.get("offer", ""),
            combo_id=combo_id,
        )
        visitor.advance_stage(VisitorStage.LANDED)
        self.visitors[visitor_id] = visitor
        return visitor

    def record_opt_in(self, visitor_id: str, email: str, name: str = "") -> None:
        v = self.visitors.get(visitor_id)
        if v:
            v.email = email
            v.name = name
            v.advance_stage(VisitorStage.OPTED_IN)
            self._fire_pixel_event(v, "Lead")

    def record_vsl_progress(self, visitor_id: str, percent: float, seconds: int) -> None:
        v = self.visitors.get(visitor_id)
        if not v:
            return
        v.vsl_watch_percent = max(v.vsl_watch_percent, percent)
        v.vsl_watch_seconds = max(v.vsl_watch_seconds, seconds)

        if percent >= 25 and VisitorStage.VSL_25 not in v.stages_completed:
            v.advance_stage(VisitorStage.VSL_25)
        if percent >= 50 and VisitorStage.VSL_50 not in v.stages_completed:
            v.advance_stage(VisitorStage.VSL_50)
        if percent >= 75 and VisitorStage.VSL_75 not in v.stages_completed:
            v.advance_stage(VisitorStage.VSL_75)
        if percent >= 95:
            v.advance_stage(VisitorStage.VSL_COMPLETE)
            self._fire_pixel_event(v, "VSLComplete")

    def record_application(self, visitor_id: str, application_data: dict[str, Any]) -> None:
        v = self.visitors.get(visitor_id)
        if not v:
            return
        v.phone = application_data.get("phone", "")
        v.role = application_data.get("role", "")
        v.monthly_listeners = application_data.get("monthly_listeners", "")
        v.current_revenue = application_data.get("generating_revenue", "")
        v.biggest_challenge = application_data.get("biggest_challenge", "")
        v.investment_ready = application_data.get("investment_ready", "")
        v.advance_stage(VisitorStage.APPLICATION_SUBMITTED)
        self._fire_pixel_event(v, "SubmitApplication")

        lead_score = self._score_application(application_data)
        log.info("application_scored", extra={"visitor_id": visitor_id, "lead_score": lead_score})

    def record_booking(self, visitor_id: str, booking_time: datetime) -> None:
        v = self.visitors.get(visitor_id)
        if v:
            v.booked_call = True
            v.booking_time = booking_time
            v.advance_stage(VisitorStage.BOOKING_CONFIRMED)
            self._fire_pixel_event(v, "Schedule")

    def record_signup(self, visitor_id: str, plan: str = "free") -> None:
        v = self.visitors.get(visitor_id)
        if v:
            v.signed_up = True
            v.advance_stage(VisitorStage.CHECKOUT_COMPLETE)
            self._fire_pixel_event(v, "StartTrial")

    def record_payment(self, visitor_id: str, amount: float) -> None:
        v = self.visitors.get(visitor_id)
        if v:
            v.paid = True
            v.deal_value = amount
            self._fire_pixel_event(v, "Purchase", {"value": amount, "currency": "USD"})

    # ── Application Scoring ──

    def _score_application(self, data: dict[str, Any]) -> int:
        score = 0
        listeners = str(data.get("monthly_listeners", "")).lower()
        if any(k in listeners for k in ("100k", "500k", "1m")):
            score += 30
        elif "50k" in listeners:
            score += 25
        elif any(k in listeners for k in ("10k", "25k")):
            score += 15

        revenue = str(data.get("generating_revenue", "")).lower()
        if revenue == "yes":
            score += 20
        elif revenue == "some":
            score += 10

        invest = str(data.get("investment_ready", "")).lower()
        if invest == "yes":
            score += 25
        elif "discuss" in invest:
            score += 10

        role = str(data.get("role", "")).lower()
        if role in ("manager", "label"):
            score += 15
        elif role == "artist":
            score += 10

        try:
            releases = int(data.get("releases_last_12mo", 0))
            if releases >= 4:
                score += 10
            elif releases >= 2:
                score += 5
        except (ValueError, TypeError):
            pass

        return min(score, 100)

    # ── Webhook Handlers ──

    def handle_stripe_webhook(self, event: dict[str, Any]) -> dict[str, Any]:
        event_type = event.get("type", "")
        data = event.get("data", {}).get("object", {})

        if event_type == "checkout.session.completed":
            email = data.get("customer_email", "")
            amount = data.get("amount_total", 0) / 100
            visitor = self._find_visitor_by_email(email)
            if visitor:
                self.record_payment(visitor.visitor_id, amount)
                return {"status": "processed", "action": "payment_recorded", "amount": amount}

        elif event_type == "customer.subscription.deleted":
            return {"status": "processed", "action": "churn_recorded"}

        return {"status": "ignored", "event_type": event_type}

    def handle_calendly_webhook(self, event: dict[str, Any]) -> dict[str, Any]:
        event_type = event.get("event", "")
        payload = event.get("payload", {})

        if event_type == "invitee.created":
            email = payload.get("email", "")
            start_time = payload.get("scheduled_event", {}).get("start_time", "")
            visitor = self._find_visitor_by_email(email)
            if visitor and start_time:
                booking_time = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
                self.record_booking(visitor.visitor_id, booking_time)
                return {"status": "processed", "action": "booking_confirmed"}

        elif event_type == "invitee.canceled":
            email = payload.get("email", "")
            visitor = self._find_visitor_by_email(email)
            if visitor:
                visitor.booked_call = False
                return {"status": "processed", "action": "booking_canceled"}

        return {"status": "ignored", "event_type": event_type}

    # ── Funnel Analytics ──

    def get_funnel_analytics(self, funnel_id: str, days: int = 30) -> dict[str, Any]:
        cutoff = datetime.now() - timedelta(days=days)
        visitors = [
            v for v in self.visitors.values()
            if v.funnel_id == funnel_id and v.entered_at >= cutoff
        ]
        if not visitors:
            return {"funnel_id": funnel_id, "period_days": days, "no_data": True}

        total = len(visitors)
        opted_in = sum(1 for v in visitors if VisitorStage.OPTED_IN in v.stages_completed)
        vsl_started = sum(1 for v in visitors if VisitorStage.WATCHING_VSL in v.stages_completed)
        vsl_complete = sum(1 for v in visitors if VisitorStage.VSL_COMPLETE in v.stages_completed)
        cta_clicked = sum(1 for v in visitors if VisitorStage.CTA_CLICKED in v.stages_completed)
        applied = sum(1 for v in visitors if VisitorStage.APPLICATION_SUBMITTED in v.stages_completed)
        booked = sum(1 for v in visitors if v.booked_call)
        signed_up = sum(1 for v in visitors if v.signed_up)
        paid = sum(1 for v in visitors if v.paid)
        total_revenue = sum(v.deal_value for v in visitors if v.paid)
        brand = self.funnels.get(funnel_id, {}).get("brand", "unknown")

        analytics: dict[str, Any] = {
            "funnel_id": funnel_id, "brand": brand, "period_days": days,
            "total_visitors": total,
            "opted_in": opted_in,
            "opt_in_rate": round(opted_in / total * 100, 1) if total > 0 else 0,
            "vsl_started": vsl_started,
            "vsl_completed": vsl_complete,
            "vsl_completion_rate": round(vsl_complete / vsl_started * 100, 1) if vsl_started > 0 else 0,
            "cta_clicked": cta_clicked,
            "cta_click_rate": round(cta_clicked / vsl_started * 100, 1) if vsl_started > 0 else 0,
            "total_revenue": round(total_revenue, 2),
        }

        if brand == "fulldigital":
            analytics.update({
                "applications": applied,
                "bookings": booked,
                "deals_closed": paid,
                "close_rate": round(paid / booked * 100, 1) if booked > 0 else 0,
            })
        else:
            analytics.update({
                "signups": signed_up,
                "paid_conversions": paid,
                "free_to_paid_rate": round(paid / signed_up * 100, 1) if signed_up > 0 else 0,
            })

        analytics["top_sources"] = self._get_attribution_breakdown(visitors, "utm_source")
        analytics["top_campaigns"] = self._get_attribution_breakdown(visitors, "utm_campaign")
        return analytics

    # ── A/B Testing ──

    def create_page_variant(self, original_page_id: str, variant_id: str, changes: dict[str, Any]) -> FunnelPage:
        original = self.pages.get(original_page_id)
        if not original:
            raise ValueError(f"Page {original_page_id} not found")

        variant = copy.deepcopy(original)
        variant.id = f"{original.id}_v_{variant_id}"
        variant.variant_id = variant_id
        variant.views = 0
        variant.conversions = 0
        for key, value in changes.items():
            if hasattr(variant, key):
                setattr(variant, key, value)
        self.pages[variant.id] = variant
        return variant

    # ── Internal Helpers ──

    def _find_visitor_by_email(self, email: str) -> FunnelVisitor | None:
        for v in self.visitors.values():
            if v.email == email:
                return v
        return None

    def _fire_pixel_event(self, visitor: FunnelVisitor, event_name: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Fire Meta Pixel event (placeholder for Conversions API)."""
        return {
            "event_name": event_name,
            "event_time": int(datetime.now().timestamp()),
            "user_data": {"em": visitor.email},
            "custom_data": {
                "brand": visitor.brand,
                "funnel_id": visitor.funnel_id,
                "combo_id": visitor.combo_id,
                **(params or {}),
            },
        }

    def _get_attribution_breakdown(self, visitors: list[FunnelVisitor], attr_field: str) -> list[dict[str, Any]]:
        breakdown: dict[str, dict[str, Any]] = {}
        for v in visitors:
            key = getattr(v, attr_field, "") or "unknown"
            if key not in breakdown:
                breakdown[key] = {"value": key, "visitors": 0, "conversions": 0, "revenue": 0.0}
            breakdown[key]["visitors"] += 1
            if v.paid or v.signed_up:
                breakdown[key]["conversions"] += 1
            breakdown[key]["revenue"] += v.deal_value
        return sorted(breakdown.values(), key=lambda x: x["revenue"], reverse=True)[:10]
