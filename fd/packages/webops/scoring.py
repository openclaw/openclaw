"""WebOps scoring — convert raw check results to RED/YELLOW/GREEN per site.

Each site gets a color:
- GREEN: all live checks passed, no warnings
- YELLOW: warnings (planned coverage gaps, soft mismatches)
- RED: any check returned ok=False

Also extracts incident records for the incidents table.
"""
from __future__ import annotations

import hashlib
from typing import Any


def _fingerprint(site_key: str, tool: str, check: str, reason: str) -> str:
    """Stable dedupe key for an incident."""
    raw = f"{site_key}|{tool}|{check}|{reason}".encode()
    return hashlib.sha256(raw).hexdigest()[:24]


def score_sites(payload: dict[str, Any]) -> dict[str, Any]:
    """Score each site as green/yellow/red and extract incidents.

    Args:
        payload: The full run_checks result dict.

    Returns:
        {"ok": bool, "sites": [...], "incidents": [...]}
    """
    site_scores: list[dict[str, Any]] = []
    incidents: list[dict[str, Any]] = []

    checks = payload.get("checks", [])
    planned = payload.get("planned_coverage", [])

    planned_by_site: dict[str, list[dict[str, Any]]] = {}
    for p in planned:
        planned_by_site.setdefault(p["site_key"], []).append(p)

    for site_check in checks:
        site_key = site_check.get("site_key", "?")
        results = site_check.get("results", [])

        failures: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []

        for item in results:
            tool = item.get("tool", "")
            check = item.get("check", "")
            r = item.get("result") or {}

            if r.get("ok") is False:
                reason = r.get("error") or "check_failed"
                failures.append({"tool": tool, "check": check, "reason": reason})
                incidents.append({
                    "site_key": site_key,
                    "severity": "red",
                    "title": f"{tool}:{check} failed",
                    "reason": reason,
                    "fingerprint": _fingerprint(site_key, tool, check, reason),
                    "details": r,
                })
            else:
                # Soft warnings for partial mismatches
                if tool == "stripe" and (r.get("missing") or r.get("mismatched")):
                    warnings.append({"tool": tool, "check": check, "reason": "webhook_mismatch"})
                if tool == "tracking" and (r.get("ga4_present") is False or r.get("posthog_present") is False):
                    warnings.append({"tool": tool, "check": check, "reason": "tracking_missing"})
                if tool in ("vercel", "webflow") and r.get("domains_ok") is False:
                    warnings.append({"tool": tool, "check": check, "reason": "domains_mismatch"})

        # Planned coverage gaps are yellow if no reds
        planned_items = planned_by_site.get(site_key, [])
        if planned_items and not failures:
            warnings.append({
                "tool": "planned",
                "check": "coverage",
                "reason": f"{len(planned_items)} tools planned/not implemented",
            })

        color = "green"
        if failures:
            color = "red"
        elif warnings:
            color = "yellow"

        site_scores.append({
            "site_key": site_key,
            "url": site_check.get("url"),
            "status": color,
            "failures": failures,
            "warnings": warnings,
        })

    ok = all(s["status"] == "green" for s in site_scores) if site_scores else True
    return {"ok": ok, "sites": site_scores, "incidents": incidents}
