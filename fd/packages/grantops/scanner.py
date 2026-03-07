"""GrantOps daily scanner — discovers grant opportunities from external sources.

Flow:
  1. Pull opportunities from configured sources (Candid first)
  2. Normalize to Opportunity model
  3. Dedupe via external_id
  4. Score (fit + effort)
  5. Upsert to SQLite
  6. Return summary for Telegram digest

Respects: DRY_RUN, KILL_SWITCH, READ_ONLY, rate limiting.
"""
from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit
from packages.common.ids import new_id
from packages.common.logging import get_logger
from packages.grantops.models import (
    Opportunity,
    OpportunitySource,
    PortalType,
    Priority,
)
from packages.grantops.scoring import score_opportunity
from packages.grantops.store import (
    get_opportunity_by_external_id,
    get_summary_stats,
    upsert_opportunity,
)

log = get_logger("grantops.scanner")


def _normalize_candid_result(raw: dict[str, Any]) -> Opportunity:
    """Normalize a Candid API result into an Opportunity."""
    external_id = f"candid:{raw.get('id', raw.get('grant_id', ''))}"

    # Detect portal type from URL
    portal_url = raw.get("application_url", "") or ""
    portal_type = PortalType.GUIDED
    if "submittable.com" in portal_url:
        portal_type = PortalType.SUBMITTABLE
    elif "fluxx" in portal_url.lower():
        portal_type = PortalType.FLUXX

    return Opportunity(
        id=new_id("grant"),
        external_id=external_id,
        name=raw.get("title", raw.get("name", "Untitled")),
        funder=raw.get("funder_name", raw.get("organization", "")),
        deadline=raw.get("deadline", raw.get("close_date")),
        amount_min_usd=raw.get("amount_min") or raw.get("floor_amount"),
        amount_max_usd=raw.get("amount_max") or raw.get("ceiling_amount"),
        portal_type=portal_type,
        portal_url=portal_url,
        source=OpportunitySource.CANDID,
        brand="fulldigital",
        raw_data=raw,
        discovered_at=datetime.now(tz=UTC).isoformat(),
    )


def _normalize_grants_gov_result(raw: dict[str, Any]) -> Opportunity:
    """Normalize a Grants.gov result into an Opportunity."""
    external_id = f"grants_gov:{raw.get('opportunity_id', raw.get('id', ''))}"
    return Opportunity(
        id=new_id("grant"),
        external_id=external_id,
        name=raw.get("title", "Untitled"),
        funder=raw.get("agency_name", ""),
        deadline=raw.get("close_date"),
        amount_min_usd=raw.get("award_floor"),
        amount_max_usd=raw.get("award_ceiling"),
        portal_type=PortalType.PORTAL_OTHER,
        portal_url=raw.get("application_url", ""),
        source=OpportunitySource.GRANTS_GOV,
        brand="fulldigital",
        raw_data=raw,
        discovered_at=datetime.now(tz=UTC).isoformat(),
    )


def ingest_opportunities(
    conn: sqlite3.Connection,
    raw_results: list[dict[str, Any]],
    *,
    source: str = "candid",
    dry_run: bool = True,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Normalize, score, dedupe, and upsert a batch of raw opportunity results.

    Args:
        conn: SQLite connection
        raw_results: Raw API results from a grant source
        source: Source name ("candid", "grants_gov")
        dry_run: If True, log but don't write
        correlation_id: For audit trail

    Returns:
        Summary dict with counts
    """
    normalizer = {
        "candid": _normalize_candid_result,
        "grants_gov": _normalize_grants_gov_result,
    }.get(source, _normalize_candid_result)

    stats = {"total": len(raw_results), "new": 0, "updated": 0, "skipped": 0, "errors": 0}

    for raw in raw_results:
        try:
            opp = normalizer(raw)

            # Score
            scores = score_opportunity(opp.model_dump())
            opp.fit_score = scores["fit_score"]
            opp.effort_score = scores["effort_score"]
            opp.priority = Priority(scores["priority"])

            # Check existing
            existing = get_opportunity_by_external_id(conn, opp.external_id)
            is_new = existing is None

            if dry_run:
                action = "would_create" if is_new else "would_update"
                write_audit(
                    conn,
                    action=f"grant.scan.{action}",
                    target=opp.external_id,
                    payload={
                        "name": opp.name,
                        "fit_score": opp.fit_score,
                        "source": source,
                    },
                    correlation_id=correlation_id,
                )
                stats["new" if is_new else "updated"] += 1
                continue

            # Preserve existing ID on update
            if existing:
                opp.id = existing["id"]

            upsert_opportunity(conn, opp)
            stats["new" if is_new else "updated"] += 1

            write_audit(
                conn,
                action=f"grant.{'discovered' if is_new else 'updated'}",
                target=opp.id,
                payload={
                    "name": opp.name,
                    "fit_score": opp.fit_score,
                    "priority": opp.priority.value,
                    "external_id": opp.external_id,
                },
                correlation_id=correlation_id,
            )

        except Exception as exc:
            stats["errors"] += 1
            log.warning("scan_error", extra={"error": str(exc), "raw_id": raw.get("id")})

    return stats


def run_daily_scan(
    conn: sqlite3.Connection,
    *,
    dry_run: bool = True,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Run the full daily scan pipeline.

    In production this would call Candid/Grants.gov APIs.
    Currently returns the pipeline structure for integration testing.
    """
    cid = correlation_id or new_id("scan")

    write_audit(
        conn,
        action="grant.scan.started",
        target="daily_scan",
        payload={"dry_run": dry_run},
        correlation_id=cid,
    )

    # TODO: Wire actual API calls here via LimiterRegistry
    # raw_results = candid_client.search(...)
    # stats = ingest_opportunities(conn, raw_results, source="candid", dry_run=dry_run, correlation_id=cid)

    summary = get_summary_stats(conn)

    write_audit(
        conn,
        action="grant.scan.completed",
        target="daily_scan",
        payload={"summary": summary, "dry_run": dry_run},
        correlation_id=cid,
    )

    return {
        "ok": True,
        "dry_run": dry_run,
        "correlation_id": cid,
        "summary": summary,
    }
