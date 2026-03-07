"""Daily WebOps report — summarize drift check results.

Produces a single summary dict suitable for writing to the System Audit Log
or embedding in the admin health endpoint response.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate a list of per-site check results into a summary."""
    ok = all(r.get("ok", True) for r in results if "ok" in r)
    failed = [r for r in results if r.get("ok") is False]

    return {
        "ok": ok,
        "timestamp": datetime.now(tz=UTC).isoformat(),
        "total": len(results),
        "passed": len(results) - len(failed),
        "failed_count": len(failed),
        "failed": failed,
    }


def build_daily_report(drift_results: dict[str, Any]) -> dict[str, Any]:
    """Build a full daily report from drift detector output.

    Reads from ``checks[]`` (new shape) with fallback to ``results[]`` (old).
    """
    site_checks = drift_results.get("checks", drift_results.get("results", []))
    summary = summarize(site_checks)

    planned = drift_results.get("planned_coverage", [])
    unique_planned = sorted({p["tool"] for p in planned})

    return {
        "report_type": "daily_webops",
        "generated_at": datetime.now(tz=UTC).isoformat(),
        "summary": summary,
        "warnings": drift_results.get("warnings", []),
        "sites_checked": drift_results.get("sites_checked", 0),
        "failed_count": len(drift_results.get("failed", [])),
        "planned_tools": unique_planned,
        "planned_count": len(planned),
    }
