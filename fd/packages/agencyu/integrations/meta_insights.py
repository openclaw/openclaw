"""Meta Insights API client — fetches ad performance data for optimization.

Thin httpx wrapper with retry/backoff and rate limiting, matching codebase
integration conventions. Safe-mode supported (all reads, no writes).

Used by MetricsAggregator to pull CTR/CPM/Frequency/Spend per combo_id.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from packages.common.logging import get_logger

log = get_logger("agencyu.integrations.meta_insights")


@dataclass
class MetaInsightsConfig:
    """Configuration for the Meta Graph API."""

    access_token: str = ""
    ad_account_id: str = ""  # "act_<id>"
    api_version: str = "v20.0"
    base_url: str = "https://graph.facebook.com"
    timeout_sec: int = 30
    max_retries: int = 5
    rate_limit_interval_sec: float = 1.0


class MetaRateLimiter:
    """Simple global cooldown limiter. Extend to per-endpoint if needed."""

    def __init__(self, min_interval_sec: float = 1.0) -> None:
        self.min_interval_sec = min_interval_sec
        self._last: float = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        delta = now - self._last
        if delta < self.min_interval_sec:
            time.sleep(self.min_interval_sec - delta)
        self._last = time.monotonic()


class MetaInsightsClient:
    """Read-only Meta Graph API client for ad insights.

    Supports retry with exponential backoff on rate-limit and transient errors.
    """

    RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

    def __init__(
        self,
        cfg: MetaInsightsConfig,
        limiter: MetaRateLimiter | None = None,
    ) -> None:
        self.cfg = cfg
        self.limiter = limiter or MetaRateLimiter(cfg.rate_limit_interval_sec)

    def _url(self, path: str) -> str:
        return f"{self.cfg.base_url}/{self.cfg.api_version}/{path}"

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        params = dict(params)
        params["access_token"] = self.cfg.access_token

        last_error = ""
        for attempt in range(1, self.cfg.max_retries + 1):
            self.limiter.wait()
            try:
                r = httpx.get(
                    self._url(path),
                    params=params,
                    timeout=self.cfg.timeout_sec,
                )
                if r.status_code == 200:
                    return r.json()

                if r.status_code in self.RETRYABLE_STATUS:
                    sleep = (2**attempt) * 0.5
                    log.warning(
                        "meta_api_retryable",
                        extra={
                            "status": r.status_code,
                            "attempt": attempt,
                            "sleep": sleep,
                        },
                    )
                    time.sleep(sleep)
                    continue

                # Non-retryable error
                return {"error": {"status": r.status_code, "body": r.text}}

            except httpx.HTTPError as e:
                last_error = str(e)
                sleep = (2**attempt) * 0.5
                log.warning(
                    "meta_api_network_error",
                    extra={"error": last_error, "attempt": attempt, "sleep": sleep},
                )
                time.sleep(sleep)

        return {"error": {"status": "retry_exhausted", "message": last_error}}

    def fetch_ad_insights(
        self,
        *,
        since: str,
        until: str,
        level: str = "ad",
        fields: list[str] | None = None,
        filtering: list[dict[str, Any]] | None = None,
        time_increment: int | None = None,
    ) -> dict[str, Any]:
        """Fetch insights for the ad account over a date range.

        Args:
            since: Start date (YYYY-MM-DD)
            until: End date (YYYY-MM-DD)
            level: Aggregation level — 'ad', 'adset', or 'campaign'
            fields: Graph API fields to request
            filtering: Graph API filtering array
            time_increment: Day-level breakdown (1 = daily)

        Returns:
            Graph API response dict with 'data' array on success,
            or {'error': ...} on failure.
        """
        fields = fields or [
            "ad_id",
            "ad_name",
            "adset_id",
            "adset_name",
            "campaign_id",
            "campaign_name",
            "impressions",
            "clicks",
            "spend",
            "ctr",
            "cpm",
            "frequency",
            "date_start",
            "date_stop",
        ]

        params: dict[str, Any] = {
            "level": level,
            "fields": ",".join(fields),
            "time_range": json.dumps({"since": since, "until": until}),
            "limit": 500,
        }
        if filtering:
            params["filtering"] = json.dumps(filtering)
        if time_increment:
            params["time_increment"] = time_increment

        return self._get(f"{self.cfg.ad_account_id}/insights", params)

    def fetch_campaigns(self) -> dict[str, Any]:
        """Fetch all campaigns for the ad account."""
        return self._get(
            f"{self.cfg.ad_account_id}/campaigns",
            {"fields": "id,name,status", "limit": 500},
        )
