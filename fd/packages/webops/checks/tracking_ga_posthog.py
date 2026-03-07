"""Tracking checks — verify GA4 and PostHog tags are present on site pages.

Fetches the live HTML of a site URL and checks that the expected tracking
snippets (measurement ID, project API key) appear in the page source.
"""
from __future__ import annotations

from typing import Any

import httpx

from packages.webops.http import with_retries
from packages.webops.providers.ga4 import GA4Client
from packages.webops.providers.posthog import PostHogClient


def _fetch_html(url: str) -> str:
    """Fetch page HTML with a browser-ish user agent."""
    r = with_retries(lambda: httpx.get(
        url,
        timeout=20,
        headers={"User-Agent": "OpenClawWebOps/1.0"},
        follow_redirects=True,
    ))
    return r.text or ""


def run_tracking_checks(
    ga: GA4Client | None,
    posthog: PostHogClient | None,
    *,
    url: str,
    ga4_measurement_id: str | None = None,
    posthog_key: str | None = None,
) -> dict[str, Any]:
    """Check that tracking tags are present in a site's HTML.

    Returns per-tracker presence booleans.
    """
    html = _fetch_html(url)

    ga_present = True
    if ga4_measurement_id and ga:
        ga_present = ga.measurement_id_present_in_html(html, ga4_measurement_id)

    ph_present = True
    if posthog_key:
        ph_present = posthog_key in html

    return {
        "ok": True,
        "url": url,
        "ga4_present": ga_present,
        "posthog_present": ph_present,
    }
