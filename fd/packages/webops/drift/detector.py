"""WebOps drift detector — runs all checks for all sites and reports findings.

Iterates over sites.yaml, instantiates provider clients, runs the appropriate
checks per hosting/DNS/tracking/webhook config, and collects results.

Also produces ``planned_coverage`` entries for every tool declared in
depends_on_tools that doesn't have a live check yet — so the report always
shows the full toolstack awareness.

This is the "reconcile" equivalent for WebOps — compare desired state
(sites.yaml) against actual state (provider APIs).
"""
from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any

from packages.common.logging import get_logger
from packages.webops.checks.cloudflare_dns_ssl import run_cloudflare_zone_check
from packages.webops.checks.stripe_webhooks import run_stripe_webhook_integrity
from packages.webops.checks.tracking_ga_posthog import run_tracking_checks
from packages.webops.checks.vercel_deployments import run_vercel_project_check
from packages.webops.checks.webflow_publish_health import run_webflow_publish_health
from packages.webops.providers.cloudflare import CloudflareClient
from packages.webops.providers.ga4 import GA4Client
from packages.webops.providers.posthog import PostHogClient
from packages.webops.providers.stripe import StripeWebhookClient
from packages.webops.providers.vercel import VercelClient
from packages.webops.providers.webflow import WebflowClient
from packages.webops.rate_limit import RateLimiter
from packages.webops.registry import load_sites, load_tool_access

log = get_logger("webops.drift.detector")


def _get_secret(ref: str) -> str:
    """Resolve a secret reference to its value (env var lookup)."""
    return os.environ.get(ref, "")


def _build_limiter(tool_cfg: dict[str, Any]) -> RateLimiter:
    rpm = tool_cfg.get("rate_limit", {}).get("rpm", 60)
    return RateLimiter(rpm=rpm)


def run_all_checks(
    *,
    sites_path: str = "config/sites.yaml",
    tool_access_path: str = "config/tool_access.yaml",
) -> dict[str, Any]:
    """Run every WebOps check for every site.

    Returns a clean report dict with:
    - checks[]: per-site check results
    - planned_coverage[]: tools declared in depends_on_tools but not yet checked
    - failed[]: normalized failures
    - warnings[]: human-readable warning strings
    """
    sites = load_sites(sites_path)
    tools = load_tool_access(tool_access_path)

    checks: list[dict[str, Any]] = []
    planned_coverage: list[dict[str, Any]] = []

    for site in sites:
        site_key = site.get("site_key", "unknown")
        url = (site.get("urls") or [None])[0]
        depends = site.get("depends_on_tools", [])
        site_check: dict[str, Any] = {"site_key": site_key, "url": url, "results": []}

        provider = site.get("provider", {})
        dns_provider = provider.get("dns")
        hosting_provider = provider.get("hosting")

        # Track which tools got a live check for this site
        checked_tools: set[str] = set()

        # ── 1) Cloudflare DNS/SSL ──
        if dns_provider == "cloudflare" or "cloudflare" in depends:
            cf_cfg = tools.get("cloudflare", {})
            cf_token = _get_secret(cf_cfg.get("secret_ref", ""))
            zone_name = site.get("cloudflare", {}).get("zone_name", "")
            if cf_token and zone_name:
                cf = CloudflareClient(cf_token, _build_limiter(cf_cfg))
                result = run_cloudflare_zone_check(cf, zone_name=zone_name)
                site_check["results"].append({
                    "tool": "cloudflare",
                    "check": "zone_dns_ssl",
                    "result": result,
                })
                checked_tools.add("cloudflare")

        # ── 2) Vercel deployments ──
        if hosting_provider == "vercel" or "vercel" in depends:
            vc_cfg = tools.get("vercel", {})
            vc_token = _get_secret(vc_cfg.get("secret_ref", ""))
            vercel_conf = site.get("vercel", {})
            project_name = vercel_conf.get("project_name", "")
            if vc_token and project_name:
                vc = VercelClient(vc_token, _build_limiter(vc_cfg))
                result = run_vercel_project_check(
                    vc,
                    project_name=project_name,
                    expected_prod_domain=vercel_conf.get("expected_prod_domain"),
                )
                site_check["results"].append({
                    "tool": "vercel",
                    "check": "deployments",
                    "result": result,
                })
                checked_tools.add("vercel")

        # ── 3) Webflow publish ──
        if hosting_provider == "webflow" or "webflow" in depends:
            wf_cfg = tools.get("webflow", {})
            wf_token = _get_secret(wf_cfg.get("secret_ref", ""))
            wf_conf = site.get("webflow", {})
            site_id = wf_conf.get("site_id", "")
            if wf_token and site_id:
                wf = WebflowClient(wf_token, _build_limiter(wf_cfg))
                result = run_webflow_publish_health(
                    wf,
                    site_id=site_id,
                    expected_domain=wf_conf.get("expected_publish_domain"),
                )
                site_check["results"].append({
                    "tool": "webflow",
                    "check": "publish_health",
                    "result": result,
                })
                checked_tools.add("webflow")

        # ── 4) GA/PostHog tracking (HTML presence) ──
        tracking = site.get("tracking", {})
        if url and tracking:
            ga_mid = tracking.get("ga4_measurement_id")
            ph_key = tracking.get("posthog_project_api_key")

            ga_client = None
            if ga_mid:
                ga_cfg = tools.get("google_analytics", {})
                ga_client = GA4Client(
                    _get_secret(ga_cfg.get("secret_ref", "")),
                    _build_limiter(ga_cfg),
                )

            ph_client = None
            if ph_key:
                ph_cfg = tools.get("posthog", {})
                ph_client = PostHogClient(
                    _get_secret(ph_cfg.get("secret_ref", "")),
                    os.environ.get("POSTHOG_HOST", "https://app.posthog.com"),
                    _build_limiter(ph_cfg),
                )

            if ga_client or ph_client:
                result = run_tracking_checks(
                    ga_client,
                    ph_client,
                    url=url,
                    ga4_measurement_id=ga_mid,
                    posthog_key=ph_key,
                )
                site_check["results"].append({
                    "tool": "tracking",
                    "check": "ga_posthog_presence",
                    "result": result,
                })
                if ga_client:
                    checked_tools.add("google_analytics")
                if ph_client:
                    checked_tools.add("posthog")

        # ── 5) Stripe webhook integrity ──
        stripe_conf = site.get("stripe", {})
        expected_endpoints = stripe_conf.get("webhook_endpoints_expected", [])
        if expected_endpoints or "stripe" in depends:
            st_cfg = tools.get("stripe", {})
            st_key = _get_secret(st_cfg.get("secret_ref", ""))
            if st_key and expected_endpoints:
                stripe_c = StripeWebhookClient(st_key, _build_limiter(st_cfg))
                result = run_stripe_webhook_integrity(
                    stripe_c,
                    expected_endpoints=expected_endpoints,
                )
                site_check["results"].append({
                    "tool": "stripe",
                    "check": "webhook_integrity",
                    "result": result,
                })
                checked_tools.add("stripe")

        checks.append(site_check)

        # ── Planned coverage: tools in depends_on_tools but not checked ──
        for tool_name in depends:
            if tool_name not in checked_tools:
                tool_cfg = tools.get(tool_name, {})
                planned_coverage.append({
                    "site_key": site_key,
                    "tool": tool_name,
                    "lane": tool_cfg.get("lane", "unknown"),
                    "planned": tool_cfg.get("planned", []),
                })

    # ── Aggregate failures + warnings ──
    failed: list[dict[str, Any]] = []
    warnings: list[str] = []

    for site_check in checks:
        sk = site_check.get("site_key", "?")
        for item in site_check.get("results", []):
            r = item.get("result", {})
            if r.get("ok") is False:
                failed.append({
                    "site_key": sk,
                    "tool": item["tool"],
                    "check": item["check"],
                    "error": r.get("error"),
                })

    if failed:
        warnings.append(f"{len(failed)} failing checks")

    if planned_coverage:
        unique_planned_tools = {p["tool"] for p in planned_coverage}
        warnings.append(
            f"{len(unique_planned_tools)} tools have planned-only coverage: "
            + ", ".join(sorted(unique_planned_tools))
        )

    all_ok = len(failed) == 0

    return {
        "ok": all_ok,
        "timestamp": datetime.now(tz=UTC).isoformat(),
        "sites_checked": len(checks),
        "checks": checks,
        "failed": failed,
        "planned_coverage": planned_coverage,
        "warnings": warnings,
    }
