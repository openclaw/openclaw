"""Cloudflare DNS + SSL health check.

Verifies that a zone exists, returns DNS record count and SSL settings.
Used by the daily WebOps reconcile to detect DNS/SSL drift.
"""
from __future__ import annotations

from typing import Any

from packages.webops.providers.cloudflare import CloudflareClient


def run_cloudflare_zone_check(
    cf: CloudflareClient,
    *,
    zone_name: str,
) -> dict[str, Any]:
    """Check a single Cloudflare zone: existence, DNS records, SSL settings."""
    zone_id = cf.get_zone_id(zone_name)
    if not zone_id:
        return {"ok": False, "error": "zone_not_found", "zone_name": zone_name}

    dns = cf.list_dns_records(zone_id)
    ssl = cf.get_zone_settings_ssl(zone_id)

    return {
        "ok": True,
        "zone_id": zone_id,
        "zone_name": zone_name,
        "dns_record_count": len(dns),
        "ssl_settings": ssl,
    }
