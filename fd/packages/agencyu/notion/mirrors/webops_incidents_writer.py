"""Mirror WebOps incidents to a Notion database.

Upserts incident pages into the "WebOps Incidents" DB keyed by fingerprint.
Respects write_lock — simulates when Notion writes are locked.

Expected DB properties:
  - Incident (title)
  - Site Key (select)
  - Severity (select): red, yellow
  - Status (select): open, closed
  - Fingerprint (rich_text)
  - First Seen (date)
  - Last Seen (date)
  - Occurrences (number)
  - Latest Details JSON (rich_text)
  - Run Correlation ID (rich_text)
"""
from __future__ import annotations

import json
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirrors.webops_incidents")


def _find_page_by_fingerprint(
    api: NotionAPI,
    db_id: str,
    fingerprint: str,
) -> dict[str, Any] | None:
    """Query the DB for a page matching the given fingerprint."""
    filter_obj = {
        "property": "Fingerprint",
        "rich_text": {"equals": fingerprint},
    }
    result = api.query_database(db_id, filter_obj=filter_obj)
    results = result.get("results", [])
    return results[0] if results else None


def _build_properties(
    incident: dict[str, Any],
    correlation_id: str,
) -> dict[str, Any]:
    """Build Notion page properties from an incident dict."""
    title_text = incident.get("title", "Unknown incident")[:180]
    details_text = json.dumps(incident.get("details") or incident.get("last_details_json") or {}, default=str)[:1800]

    return {
        "Incident": {"title": [{"text": {"content": title_text}}]},
        "Site Key": {"select": {"name": incident.get("site_key", "unknown")}},
        "Severity": {"select": {"name": incident.get("severity", "yellow")}},
        "Status": {"select": {"name": incident.get("status", "open")}},
        "Fingerprint": {"rich_text": [{"text": {"content": incident["fingerprint"]}}]},
        "First Seen": {"date": {"start": incident.get("first_seen_utc", "")}},
        "Last Seen": {"date": {"start": incident.get("last_seen_utc", "")}},
        "Occurrences": {"number": int(incident.get("occurrences", 1))},
        "Latest Details JSON": {"rich_text": [{"text": {"content": details_text}}]},
        "Run Correlation ID": {"rich_text": [{"text": {"content": correlation_id}}]},
    }


def mirror_incident_to_notion(
    api: NotionAPI,
    *,
    db_id: str,
    incident: dict[str, Any],
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Upsert a single incident to the Notion WebOps Incidents DB.

    Args:
        api: Notion API client.
        db_id: The Notion database ID for WebOps Incidents.
        incident: Incident dict with at least fingerprint, site_key, severity, title.
        safe_mode: If True, simulate only (no Notion writes).
        correlation_id: Tracking ID for this operation.
    """
    fp = incident["fingerprint"]
    props = _build_properties(incident, correlation_id)

    if safe_mode:
        return {"ok": True, "simulated": True, "action": "upsert", "fingerprint": fp}

    existing = _find_page_by_fingerprint(api, db_id, fp)

    if existing:
        api.update_page(page_id=existing["id"], properties=props)
        log.info("notion_incident_updated", extra={"fingerprint": fp, "page_id": existing["id"]})
        return {"ok": True, "action": "updated", "page_id": existing["id"], "fingerprint": fp}

    # Create new page
    result = api._request("POST", "/pages", {
        "parent": {"database_id": db_id},
        "properties": props,
    })
    page_id = result.get("id", "")
    log.info("notion_incident_created", extra={"fingerprint": fp, "page_id": page_id})
    return {"ok": True, "action": "created", "page_id": page_id, "fingerprint": fp}


def mirror_all_open_incidents(
    api: NotionAPI,
    *,
    db_id: str,
    incidents: list[dict[str, Any]],
    safe_mode: bool = True,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Mirror all open incidents to Notion. Returns summary."""
    results: list[dict[str, Any]] = []
    for inc in incidents:
        r = mirror_incident_to_notion(
            api,
            db_id=db_id,
            incident=inc,
            safe_mode=safe_mode,
            correlation_id=correlation_id,
        )
        results.append(r)

    return {
        "ok": True,
        "safe_mode": safe_mode,
        "total": len(results),
        "results": results,
    }
