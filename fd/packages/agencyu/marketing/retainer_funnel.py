"""Retainer Conversion Funnel — post-purchase conversion system.

Converts one-off clients into retainers:
- Detects candidates (spend >= $5k OR projects >= 2)
- Generates pitch assets (pitch doc, DM script, email sequence, call agenda)
- Queues outreach sequences for human approval
- Never auto-sends messages in v1

Asset types:
- pitch_doc: Structured retainer pitch (Notion doc format)
- dm_script: DM outreach message
- email_sequence: Multi-step email sequence
- call_agenda: Agenda for upsell call
- offer_intent: Stripe payment link prep
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from packages.common.idempotency import seen_or_mark
from packages.common.ids import make_id
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.retainer_funnel")

_FUNNEL_PATH = Path(__file__).resolve().parent.parent.parent.parent / "config" / "retainer_funnel.yaml"


# ── Data models ──


@dataclass(frozen=True)
class RetainerCandidate:
    """A client detected as a retainer candidate."""

    contact_key: str
    brand: str
    client_name: str
    total_spend_cents: int
    projects_completed: int
    days_since_first_purchase: int
    suggested_retainer_id: str
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "contact_key": self.contact_key,
            "brand": self.brand,
            "client_name": self.client_name,
            "total_spend": self.total_spend_cents,
            "projects_completed": self.projects_completed,
            "days_active": self.days_since_first_purchase,
            "suggested_retainer": self.suggested_retainer_id,
            "reason": self.reason,
        }


@dataclass
class RetainerAssets:
    """Generated assets for a retainer candidate."""

    contact_key: str
    pitch_doc: str
    dm_script: str
    email_sequence: list[dict[str, str]]
    call_agenda: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "contact_key": self.contact_key,
            "pitch_doc": self.pitch_doc,
            "dm_script": self.dm_script,
            "email_steps": len(self.email_sequence),
            "call_agenda": self.call_agenda,
        }


# ── Config loading ──


def load_funnel_config(path: Path | None = None) -> dict[str, Any]:
    """Load retainer_funnel.yaml config."""
    p = path or _FUNNEL_PATH
    if not p.exists():
        return {}
    with open(p) as f:
        raw = yaml.safe_load(f) or {}
    return raw.get("retainer_funnel", raw)


# ── Candidate detection ──


def find_candidates(
    conn: sqlite3.Connection,
    *,
    config: dict[str, Any] | None = None,
) -> list[RetainerCandidate]:
    """Find clients eligible for retainer conversion.

    Rules (from config):
    - total_spend >= min_total_spend_cents
    - OR projects_completed >= min_projects_completed
    - AND days_since_first_purchase >= min_days
    - AND no active retainer
    """
    cfg = config or load_funnel_config()
    rules = cfg.get("candidate_rules", {})

    min_spend = int(rules.get("min_total_spend_cents", 500_000))
    min_projects = int(rules.get("min_projects_completed", 2))
    min_days = int(rules.get("min_days_since_first_purchase", 30))

    candidates: list[RetainerCandidate] = []

    try:
        rows = conn.execute(
            """SELECT
                la.contact_key,
                la.brand,
                COALESCE(json_extract(ae.payload_json, '$.name'), la.contact_key) AS client_name,
                COALESCE(SUM(ra.amount_cents), 0) AS total_spend,
                COUNT(DISTINCT ra.stripe_event_id) AS projects,
                CAST(
                    (julianday('now') - julianday(la.first_touch_ts)) AS INTEGER
                ) AS days_active
            FROM lead_attribution la
            LEFT JOIN revenue_attribution ra ON ra.contact_key = la.contact_key
            LEFT JOIN attribution_events ae ON ae.chain_id = la.chain_id
                AND ae.stage = 'checkout_paid'
            WHERE la.primary_stage IN ('closed_won', 'checkout_paid')
            GROUP BY la.contact_key
            HAVING (total_spend >= ? OR projects >= ?)
                AND days_active >= ?""",
            (min_spend, min_projects, min_days),
        ).fetchall()

        # Filter out already-converted candidates
        for r in rows:
            ck = r["contact_key"]

            # Check if already a retainer candidate
            existing = conn.execute(
                "SELECT status FROM retainer_candidates WHERE client_contact_key = ? AND status NOT IN ('dismissed')",
                (ck,),
            ).fetchone()
            if existing:
                continue

            spend = int(r["total_spend"] or 0)
            projects = int(r["projects"] or 0)
            days = int(r["days_active"] or 0)

            reasons = []
            if spend >= min_spend:
                reasons.append(f"spend ${spend / 100:,.0f}")
            if projects >= min_projects:
                reasons.append(f"{projects} projects")

            # Pick suggested retainer based on spend tier
            suggested = "era_control_90" if spend >= 1_000_000 else "growth_pack_90"

            candidates.append(RetainerCandidate(
                contact_key=ck,
                brand=r["brand"],
                client_name=r["client_name"] or ck,
                total_spend_cents=spend,
                projects_completed=projects,
                days_since_first_purchase=days,
                suggested_retainer_id=suggested,
                reason=" + ".join(reasons),
            ))

    except Exception:
        log.warning("retainer_candidates_query_error", exc_info=True)

    return candidates


# ── Asset generation ──


def generate_retainer_assets(
    candidate: RetainerCandidate,
    *,
    config: dict[str, Any] | None = None,
) -> RetainerAssets:
    """Generate retainer pitch assets for a candidate.

    These are draft templates — human reviews before sending.
    """
    cfg = config or load_funnel_config()
    offers = cfg.get("offers", [])

    # Find the suggested retainer offer
    offer = next(
        (o for o in offers if o.get("retainer_id") == candidate.suggested_retainer_id),
        offers[0] if offers else {},
    )

    offer_name = offer.get("name", "Era Control Retainer")
    price = offer.get("price_monthly_cents", 600_000)
    promise = offer.get("promise", "Run your release visuals like a major label.")
    includes = offer.get("includes", [])

    name = candidate.client_name

    # Pitch doc
    pitch_doc = f"""# Retainer Pitch — {name}

## Why {name} is a Perfect Fit
- Total investment: ${candidate.total_spend_cents / 100:,.0f}
- Projects completed: {candidate.projects_completed}
- Active for {candidate.days_since_first_purchase} days

## The Offer: {offer_name}
**{promise}**

Price: ${price / 100:,.0f}/month
Duration: {offer.get('duration_days', 90)} days

### What's Included:
{chr(10).join(f'- {item}' for item in includes)}

## Why Now
Your recent project momentum means you're in the perfect position to lock in consistent visual presence."""

    # DM script
    dm_script = f"""Hey {name} — your last project is performing really well.

I wanted to reach out because we have a {offer_name} that's designed for artists exactly in your position — momentum from a strong project, ready to keep building.

It's ${price / 100:,.0f}/mo for {offer.get('duration_days', 90)} days. {promise}

Want me to send over the details?"""

    # Email sequence
    sequences = cfg.get("sequences", [])
    email_steps: list[dict[str, str]] = []

    for seq in sequences:
        for step in seq.get("steps", []):
            if step.get("channel") == "email":
                email_steps.append({
                    "template": step["template"],
                    "subject": step.get("subject", ""),
                    "day_offset": str(step.get("day_offset", 0)),
                })

    if not email_steps:
        email_steps = [
            {"template": "retainer_nudge_1", "subject": f"Your project is live — here's what's next, {name}", "day_offset": "2"},
            {"template": "retainer_case_study", "subject": "How similar artists turned one project into a movement", "day_offset": "9"},
            {"template": "retainer_final_nudge", "subject": "Last chance: lock in your retainer rate", "day_offset": "14"},
        ]

    # Call agenda
    call_agenda = f"""# Retainer Call Agenda — {name}

1. **Review Results** (5 min)
   - Show metrics from completed project(s)
   - Highlight wins and audience growth

2. **Present the Retainer** (10 min)
   - {offer_name}: {promise}
   - Walk through what's included
   - Show before/after of retainer clients

3. **Handle Objections** (5 min)
   - "I don't have another release soon" → content keeps momentum
   - "It's expensive" → compare to per-project cost
   - "I need to think about it" → limited spots, lock rate now

4. **Close** (5 min)
   - Offer link ready
   - First month starts immediately
   - Onboarding within 48 hours"""

    return RetainerAssets(
        contact_key=candidate.contact_key,
        pitch_doc=pitch_doc,
        dm_script=dm_script,
        email_sequence=email_steps,
        call_agenda=call_agenda,
    )


# ── Funnel execution ──


def run_retainer_scan(
    conn: sqlite3.Connection,
    *,
    safe_mode: bool = True,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the retainer candidate scan + asset generation.

    In safe_mode, returns candidates + assets without writing to DB.
    """
    cfg = config or load_funnel_config()
    safety = cfg.get("safety", cfg.get("candidate_rules", {}))
    max_candidates = int(safety.get("max_candidates_per_run", 20))

    candidates = find_candidates(conn, config=cfg)[:max_candidates]

    results: list[dict[str, Any]] = []
    applied = 0

    for candidate in candidates:
        assets = generate_retainer_assets(candidate, config=cfg)
        entry = {
            "candidate": candidate.to_dict(),
            "assets_summary": assets.to_dict(),
        }

        if not safe_mode:
            idem_key = f"retainer:{candidate.contact_key}:{candidate.suggested_retainer_id}"
            if seen_or_mark(conn, idem_key):
                entry["status"] = "already_processed"
                results.append(entry)
                continue

            now = datetime.now(UTC).isoformat()
            try:
                conn.execute(
                    """INSERT INTO retainer_candidates
                       (id, client_contact_key, brand, total_spend_cents, projects_completed,
                        days_since_first_purchase, retainer_offer_id, status, assets_json,
                        detected_at, idempotency_key)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 'assets_generated', ?, ?, ?)""",
                    (
                        make_id("rc"),
                        candidate.contact_key,
                        candidate.brand,
                        candidate.total_spend_cents,
                        candidate.projects_completed,
                        candidate.days_since_first_purchase,
                        candidate.suggested_retainer_id,
                        json.dumps({
                            "pitch_doc": assets.pitch_doc,
                            "dm_script": assets.dm_script,
                            "email_sequence": assets.email_sequence,
                            "call_agenda": assets.call_agenda,
                        }),
                        now,
                        idem_key,
                    ),
                )
                applied += 1
                entry["status"] = "saved"
            except Exception:
                log.debug("retainer_save_error", exc_info=True)
                entry["status"] = "error"

        results.append(entry)

    if not safe_mode:
        try:
            conn.commit()
        except Exception:
            pass

    return {
        "ok": True,
        "safe_mode": safe_mode,
        "candidates_found": len(candidates),
        "applied": applied,
        "results": results,
        "ts": datetime.now(UTC).isoformat(),
    }
