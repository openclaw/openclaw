"""GrantOps drafting workflow — assembles grant application packages.

Flow:
  1. Extract requirements from opportunity
  2. Load business profile vault snapshot
  3. Generate narrative, budget justification, timeline
  4. Assemble package manifest
  5. Upsert draft to SQLite

All generation is currently template-driven. AI-assisted generation
can be added later by swapping the template functions.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit
from packages.common.ids import new_id
from packages.common.logging import get_logger
from packages.grantops.models import Draft, DraftStatus
from packages.grantops.store import (
    get_opportunity,
    insert_draft,
    update_draft_status,
    update_opportunity_status,
)

log = get_logger("grantops.drafter")


def extract_requirements(opp: dict[str, Any]) -> dict[str, Any]:
    """Parse opportunity data to identify required application sections."""
    raw = opp.get("raw_data_json", "{}")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            raw = {}

    return {
        "narrative_required": True,
        "budget_required": True,
        "timeline_required": True,
        "narrative_word_limit": raw.get("narrative_word_limit", 1000),
        "budget_detail": raw.get("budget_detail", "summary"),
        "required_attachments": raw.get("required_attachments", []),
        "references_required": raw.get("references_required", 0),
        "custom_questions": raw.get("custom_questions", []),
    }


def generate_narrative(
    opp: dict[str, Any],
    requirements: dict[str, Any],
    vault_snapshot: dict[str, Any] | None = None,
) -> str:
    """Generate a narrative section for the grant application.

    Currently uses a template. Can be extended with AI generation.
    """
    org_name = (vault_snapshot or {}).get("org_name", "Our Organization")
    mission = (vault_snapshot or {}).get("mission", "advancing digital media and creative services")

    return (
        f"{org_name} seeks funding from {opp.get('funder', 'this opportunity')} "
        f"to advance our mission of {mission}. "
        f"This project aligns with the grant's focus on {opp.get('name', 'the stated objectives')}.\n\n"
        f"Project Scope: We propose to leverage our team's expertise in digital media production, "
        f"creative technology, and brand development to deliver measurable outcomes.\n\n"
        f"Expected Impact: This funding will enable us to scale our impact, "
        f"serving additional clients and communities through innovative digital solutions."
    )


def generate_budget(
    opp: dict[str, Any],
    requirements: dict[str, Any],
) -> dict[str, Any]:
    """Generate a budget justification."""
    max_amount = opp.get("amount_max_usd") or 25000

    return {
        "total_requested": max_amount,
        "line_items": [
            {"category": "Personnel", "amount": round(max_amount * 0.45), "justification": "Project team salaries and benefits"},
            {"category": "Equipment & Software", "amount": round(max_amount * 0.20), "justification": "Production tools and licenses"},
            {"category": "Operations", "amount": round(max_amount * 0.15), "justification": "Facility costs and operational expenses"},
            {"category": "Marketing & Outreach", "amount": round(max_amount * 0.10), "justification": "Project promotion and community engagement"},
            {"category": "Administrative", "amount": round(max_amount * 0.10), "justification": "Administrative overhead and reporting"},
        ],
        "cost_share": 0,
        "in_kind": 0,
    }


def generate_timeline(opp: dict[str, Any]) -> list[str]:
    """Generate project timeline milestones."""
    return [
        "Month 1-2: Project planning, team onboarding, resource allocation",
        "Month 3-4: Phase 1 deliverables — core development and initial production",
        "Month 5-6: Phase 2 deliverables — testing, refinement, community engagement",
        "Month 7-8: Phase 3 deliverables — launch, distribution, impact measurement",
        "Month 9-10: Evaluation, reporting, sustainability planning",
        "Month 11-12: Final reporting, outcomes documentation, dissemination",
    ]


def create_draft_package(
    conn: sqlite3.Connection,
    opp_id: str,
    *,
    vault_snapshot: dict[str, Any] | None = None,
    dry_run: bool = True,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Create a complete draft package for an opportunity.

    Args:
        conn: SQLite connection
        opp_id: Opportunity ID to draft for
        vault_snapshot: Business profile vault data
        dry_run: If True, simulate only
        correlation_id: Audit trail ID
    """
    cid = correlation_id or new_id("draft")

    opp = get_opportunity(conn, opp_id)
    if not opp:
        return {"ok": False, "error": "opportunity_not_found"}

    # Extract requirements
    reqs = extract_requirements(opp)

    # Generate components
    narrative = generate_narrative(opp, reqs, vault_snapshot)
    budget = generate_budget(opp, reqs)
    timeline = generate_timeline(opp)

    # Build manifest
    manifest = {
        "opportunity_id": opp_id,
        "opportunity_name": opp["name"],
        "requirements": reqs,
        "components": {
            "narrative": {"status": "generated", "word_count": len(narrative.split())},
            "budget": {"status": "generated", "total": budget["total_requested"]},
            "timeline": {"status": "generated", "milestones": len(timeline)},
        },
        "attachments_needed": reqs.get("required_attachments", []),
        "vault_snapshot_id": (vault_snapshot or {}).get("snapshot_id", ""),
        "created_at": datetime.now(tz=UTC).isoformat(),
    }

    if dry_run:
        write_audit(
            conn,
            action="grant.draft.would_create",
            target=opp_id,
            payload={"manifest": manifest},
            correlation_id=cid,
        )
        return {"ok": True, "dry_run": True, "manifest": manifest}

    # Create draft
    draft = Draft(
        opportunity_id=opp_id,
        name=f"Draft: {opp['name']}",
        status=DraftStatus.REQUIREMENTS_EXTRACTED,
        narrative=narrative,
        budget=budget,
        timeline=timeline,
        manifest=manifest,
        vault_snapshot_id=(vault_snapshot or {}).get("snapshot_id", ""),
    )
    draft_id = insert_draft(conn, draft)

    # Update opportunity status
    update_opportunity_status(conn, opp_id, "drafting")

    write_audit(
        conn,
        action="grant.draft.created",
        target=draft_id,
        payload={
            "opportunity_id": opp_id,
            "manifest_summary": {
                "narrative_words": len(narrative.split()),
                "budget_total": budget["total_requested"],
                "timeline_milestones": len(timeline),
            },
        },
        correlation_id=cid,
    )

    return {
        "ok": True,
        "draft_id": draft_id,
        "opportunity_id": opp_id,
        "manifest": manifest,
    }
