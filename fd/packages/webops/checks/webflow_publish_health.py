"""Webflow publish health check.

Verifies that a Webflow site exists and its expected domain is attached.
"""
from __future__ import annotations

from typing import Any

from packages.webops.providers.webflow import WebflowClient


def run_webflow_publish_health(
    wf: WebflowClient,
    *,
    site_id: str,
    expected_domain: str | None = None,
) -> dict[str, Any]:
    """Check Webflow site existence and domain configuration."""
    site = wf.get_site(site_id)
    if not site:
        return {"ok": False, "error": "site_not_found", "site_id": site_id}

    domains_resp = wf.get_domains(site_id)

    domain_ok = True
    if expected_domain and isinstance(domains_resp, dict):
        doms = domains_resp.get("domains") or domains_resp.get("result") or []
        domain_ok = any(
            d.get("name") == expected_domain or d.get("domain") == expected_domain
            for d in doms
        )

    return {
        "ok": True,
        "site": {"id": site_id, "name": site.get("name")},
        "domains_ok": domain_ok,
        "domains": domains_resp,
    }
