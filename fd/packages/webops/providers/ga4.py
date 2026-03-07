"""GA4 client — page-source tag verification.

For v1, OpenClaw verifies that the GA4 measurement ID appears in page HTML
(client-side gtag snippet). No Measurement Protocol calls are made.
"""
from __future__ import annotations

from packages.webops.rate_limit import RateLimiter


class GA4Client:
    """Minimal GA4 client for tag verification."""

    def __init__(self, api_key: str, limiter: RateLimiter) -> None:
        self.api_key = api_key
        self.limiter = limiter

    def measurement_id_present_in_html(self, html: str, measurement_id: str) -> bool:
        """Check whether a measurement ID appears in page HTML."""
        return measurement_id in html
