"""Conservative provider rate limit configs — safe defaults for all integrations.

These are intentionally low to prevent bans / 429 cascades. Increase only
after confirming actual provider limits.

Usage::

    from packages.common.provider_limits import PROVIDER_LIMITS, GLOBAL_LIMIT
    from packages.common.rate_limit import LimiterRegistry

    limiters = LimiterRegistry(PROVIDER_LIMITS, global_cfg=GLOBAL_LIMIT)
    result = limiters.run("notion", lambda: notion_client.pages.retrieve(page_id))
"""
from __future__ import annotations

from packages.common.rate_limit import RateLimitConfig

PROVIDER_LIMITS: dict[str, RateLimitConfig] = {
    # Meta: very conservative; Meta has strict rate behavior and ban risk.
    # Writes require approval ALWAYS.
    "meta": RateLimitConfig(
        rps=0.5,
        burst=3,
        max_retries=5,
        base_backoff_s=2.0,
        max_backoff_s=120.0,
        jitter_s=0.5,
        cb_fail_threshold=4,
        cb_open_seconds=1800,   # 30 min cooldown
        cb_half_open_after_s=300,
        requires_write_approval=True,
    ),

    # Notion: conservative; Notion 429s easily on bulk writes.
    "notion": RateLimitConfig(
        rps=0.3,
        burst=2,
        max_retries=6,
        base_backoff_s=1.0,
        max_backoff_s=60.0,
        jitter_s=0.4,
        cb_fail_threshold=4,
        cb_open_seconds=1800,
        cb_half_open_after_s=180,
    ),

    # Cloudflare: friendly but don't spam cache purges.
    "cloudflare": RateLimitConfig(
        rps=1.0,
        burst=5,
        max_retries=4,
        base_backoff_s=1.0,
        max_backoff_s=30.0,
        cb_fail_threshold=6,
        cb_open_seconds=600,
    ),

    # Vercel: similar profile to Cloudflare.
    "vercel": RateLimitConfig(
        rps=1.0,
        burst=5,
        max_retries=4,
        base_backoff_s=1.0,
        max_backoff_s=30.0,
        cb_fail_threshold=6,
        cb_open_seconds=600,
    ),

    # Stripe: stable but keep sane rate.
    "stripe": RateLimitConfig(
        rps=1.0,
        burst=5,
        max_retries=5,
        base_backoff_s=0.5,
        max_backoff_s=30.0,
        cb_fail_threshold=6,
        cb_open_seconds=600,
    ),

    # GHL: moderate limits.
    "ghl": RateLimitConfig(
        rps=0.7,
        burst=4,
        max_retries=4,
        base_backoff_s=1.0,
        max_backoff_s=60.0,
        cb_fail_threshold=6,
        cb_open_seconds=1800,
    ),

    # Trello: moderate limits (also has its own tenacity-based retry in
    # packages/integrations/trello/rate_limit.py).
    "trello": RateLimitConfig(
        rps=0.5,
        burst=3,
        max_retries=4,
        base_backoff_s=1.0,
        max_backoff_s=60.0,
        cb_fail_threshold=5,
        cb_open_seconds=1800,
    ),

    # Google APIs: low polling, rely on webhooks where possible.
    "google": RateLimitConfig(
        rps=0.5,
        burst=3,
        max_retries=6,
        base_backoff_s=1.5,
        max_backoff_s=60.0,
        cb_fail_threshold=4,
        cb_open_seconds=1800,
    ),

    # Candid: grant discovery API. Conservative — daily batch only.
    "candid": RateLimitConfig(
        rps=0.5,
        burst=2,
        max_retries=4,
        base_backoff_s=2.0,
        max_backoff_s=60.0,
        cb_fail_threshold=3,
        cb_open_seconds=3600,
    ),

    # Submittable: grant submission API. Writes require approval.
    "submittable": RateLimitConfig(
        rps=1.0,
        burst=3,
        max_retries=4,
        base_backoff_s=1.0,
        max_backoff_s=30.0,
        cb_fail_threshold=3,
        cb_open_seconds=1800,
        requires_write_approval=True,
    ),

    # Grants.gov: federal grant search. Very conservative.
    "grants_gov": RateLimitConfig(
        rps=0.3,
        burst=1,
        max_retries=3,
        base_backoff_s=3.0,
        max_backoff_s=120.0,
        cb_fail_threshold=3,
        cb_open_seconds=3600,
    ),
}

# Global limiter: caps total outbound requests across all providers.
GLOBAL_LIMIT = RateLimitConfig(
    rps=2.0,
    burst=10,
    max_retries=5,
    base_backoff_s=1.0,
    max_backoff_s=30.0,
    cb_fail_threshold=8,
    cb_open_seconds=900,   # 15 min
)
