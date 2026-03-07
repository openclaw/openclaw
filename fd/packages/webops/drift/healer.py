"""WebOps drift healer — act on findings from the detector.

v1 is read-only: it reports what *would* need fixing but does not
auto-remediate.  Future versions can add safe-mode mutations (e.g.
purge Cloudflare cache, trigger Vercel redeploy) behind mutation_guard.
"""
from __future__ import annotations

from typing import Any

from packages.common.logging import get_logger

log = get_logger("webops.drift.healer")


def propose_fixes(drift_results: dict[str, Any]) -> list[dict[str, Any]]:
    """Analyze drift results and return a list of proposed fixes.

    Each fix is a dict with: site_key, check, action, detail.
    In v1 these are informational only — no auto-execution.

    Reads from the new ``checks[]`` format where each site has a
    ``results`` list of ``{tool, check, result}`` dicts.
    """
    proposals: list[dict[str, Any]] = []

    for site_check in drift_results.get("checks", []):
        site_key = site_check.get("site_key", "?")

        for item in site_check.get("results", []):
            tool = item.get("tool", "")
            r = item.get("result", {})

            # ── Cloudflare ──
            if tool == "cloudflare" and not r.get("ok"):
                proposals.append({
                    "site_key": site_key,
                    "check": "cloudflare",
                    "action": "verify_zone_exists",
                    "detail": r.get("error", "unknown"),
                })

            # ── Vercel ──
            if tool == "vercel":
                if not r.get("ok"):
                    proposals.append({
                        "site_key": site_key,
                        "check": "vercel",
                        "action": "verify_project_and_domain",
                        "detail": r.get("error", "unknown"),
                    })
                elif not r.get("domains_ok", True):
                    proposals.append({
                        "site_key": site_key,
                        "check": "vercel",
                        "action": "attach_expected_domain",
                        "detail": "expected domain not found in project domains",
                    })

            # ── Webflow ──
            if tool == "webflow":
                if not r.get("ok"):
                    proposals.append({
                        "site_key": site_key,
                        "check": "webflow",
                        "action": "verify_site_exists",
                        "detail": r.get("error", "unknown"),
                    })
                elif not r.get("domains_ok", True):
                    proposals.append({
                        "site_key": site_key,
                        "check": "webflow",
                        "action": "verify_publish_domain",
                        "detail": "expected domain not found in webflow domains",
                    })

            # ── Tracking ──
            if tool == "tracking":
                if not r.get("ga4_present", True):
                    proposals.append({
                        "site_key": site_key,
                        "check": "tracking",
                        "action": "add_ga4_tag",
                        "detail": "GA4 measurement ID not found in page HTML",
                    })
                if not r.get("posthog_present", True):
                    proposals.append({
                        "site_key": site_key,
                        "check": "tracking",
                        "action": "add_posthog_snippet",
                        "detail": "PostHog project key not found in page HTML",
                    })

            # ── Stripe ──
            if tool == "stripe":
                for url in r.get("missing", []):
                    proposals.append({
                        "site_key": site_key,
                        "check": "stripe",
                        "action": "create_webhook_endpoint",
                        "detail": f"missing: {url}",
                    })
                for mm in r.get("mismatched", []):
                    proposals.append({
                        "site_key": site_key,
                        "check": "stripe",
                        "action": "update_webhook_events",
                        "detail": f"missing events on {mm['url']}: {mm.get('missing_events')}",
                    })

    log.info("drift_proposals", extra={"count": len(proposals)})
    return proposals
