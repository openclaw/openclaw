"""Attribution Chain — UTM integrity enforcement across ManyChat → GHL → Notion → Stripe → QB.

Builds verified attribution payloads and validates chain completeness.
Prevents revenue blindness by flagging broken attribution links.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ChainLink:
    """A single link in the attribution chain."""
    system: str
    present: bool
    value: str | None = None


@dataclass(frozen=True)
class AttributionChain:
    """Full attribution chain validation result."""
    contact_key: str
    campaign_id: str | None
    links: list[ChainLink]
    complete: bool
    missing_systems: list[str]
    payload: dict[str, Any]


def build_attribution_payload(
    contact: dict[str, Any],
    stripe_event: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a canonical attribution payload for cross-system storage.

    Stored in: Stripe metadata, Notion Revenue DB, QuickBooks memo.
    """
    payload: dict[str, Any] = {
        "campaign_id": contact.get("campaign_id") or contact.get("campaign"),
        "utm_source": contact.get("utm_source"),
        "utm_medium": contact.get("utm_medium"),
        "utm_campaign": contact.get("utm_campaign") or contact.get("campaign"),
        "utm_content": contact.get("utm_content"),
        "utm_term": contact.get("utm_term"),
        "ghl_contact_id": contact.get("ghl_contact_id") or contact.get("ghl_id"),
        "manychat_contact_id": contact.get("manychat_contact_id"),
        "brand": contact.get("brand"),
    }

    if stripe_event:
        payload["stripe_checkout_id"] = stripe_event.get("checkout_id") or stripe_event.get("stripe_checkout_session_id")
        payload["stripe_payment_intent_id"] = stripe_event.get("payment_intent_id") or stripe_event.get("stripe_payment_intent_id")
        payload["amount_cents"] = stripe_event.get("amount_cents") or stripe_event.get("amount_total")

    return {k: v for k, v in payload.items() if v is not None}


def validate_attribution_chain(
    contact: dict[str, Any],
    stripe_event: dict[str, Any] | None = None,
    notion_record: dict[str, Any] | None = None,
    qb_record: dict[str, Any] | None = None,
) -> AttributionChain:
    """Validate the full attribution chain across all systems.

    Checks: ManyChat → GHL → Notion → Stripe → QuickBooks.
    Returns chain with completeness flag and missing systems.
    """
    contact_key = (
        contact.get("ghl_contact_id")
        or contact.get("manychat_contact_id")
        or contact.get("email")
        or "unknown"
    )

    links: list[ChainLink] = []
    missing: list[str] = []

    # ManyChat
    mc_id = contact.get("manychat_contact_id")
    links.append(ChainLink(system="manychat", present=bool(mc_id), value=mc_id))
    if not mc_id:
        missing.append("manychat")

    # GHL
    ghl_id = contact.get("ghl_contact_id") or contact.get("ghl_id")
    links.append(ChainLink(system="ghl", present=bool(ghl_id), value=ghl_id))
    if not ghl_id:
        missing.append("ghl")

    # UTM campaign (required for attribution)
    utm = contact.get("utm_campaign") or contact.get("campaign")
    links.append(ChainLink(system="utm", present=bool(utm), value=utm))
    if not utm:
        missing.append("utm")

    # Notion
    notion_present = bool(notion_record and notion_record.get("notion_page_id"))
    links.append(ChainLink(
        system="notion",
        present=notion_present,
        value=notion_record.get("notion_page_id") if notion_record else None,
    ))
    if not notion_present:
        missing.append("notion")

    # Stripe
    stripe_present = bool(stripe_event and (
        stripe_event.get("checkout_id") or stripe_event.get("stripe_checkout_session_id")
    ))
    links.append(ChainLink(
        system="stripe",
        present=stripe_present,
        value=(stripe_event or {}).get("checkout_id") or (stripe_event or {}).get("stripe_checkout_session_id"),
    ))
    if not stripe_present:
        missing.append("stripe")

    # QuickBooks
    qb_present = bool(qb_record and qb_record.get("qb_invoice_id"))
    links.append(ChainLink(
        system="quickbooks",
        present=qb_present,
        value=qb_record.get("qb_invoice_id") if qb_record else None,
    ))
    if not qb_present:
        missing.append("quickbooks")

    payload = build_attribution_payload(contact, stripe_event)

    return AttributionChain(
        contact_key=contact_key,
        campaign_id=utm,
        links=links,
        complete=len(missing) == 0,
        missing_systems=missing,
        payload=payload,
    )
