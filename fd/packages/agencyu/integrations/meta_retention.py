"""Meta retention metrics ingestion skeleton — creative quality signals.

Fetches thruplay_rate, video_3s_view_rate, and avg_watch_pct from
Meta Insights API and writes to mv_creative_daily rollup table.

This is a skeleton — actual Meta API calls are behind the MetaInsightsClient.
Enable by setting content_retention.enabled=true in experiment_policy.yaml
once Meta thruplay data is flowing.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.integrations.meta_retention")


@dataclass
class CreativeRetentionRow:
    """Single row for mv_creative_daily."""

    creative_id: str
    brand: str
    day: str
    impressions: int = 0
    thruplay_count: int = 0
    thruplay_rate: float = 0.0
    view_3s_count: int = 0
    view_3s_rate: float = 0.0
    avg_watch_pct: float = 0.0


def ingest_creative_retention(
    conn: sqlite3.Connection,
    rows: list[CreativeRetentionRow],
) -> int:
    """Write creative retention rows to mv_creative_daily.

    Uses INSERT OR REPLACE to update existing rows for the same
    (creative_id, brand, day) triple.

    Returns count of rows written.
    """
    count = 0
    for r in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO mv_creative_daily
                (creative_id, brand, day, impressions,
                 thruplay_count, thruplay_rate,
                 view_3s_count, view_3s_rate,
                 avg_watch_pct, refreshed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                (
                    r.creative_id, r.brand, r.day,
                    r.impressions,
                    r.thruplay_count, r.thruplay_rate,
                    r.view_3s_count, r.view_3s_rate,
                    r.avg_watch_pct,
                ),
            )
            count += 1
        except Exception:
            log.warning(
                "creative_retention_write_error",
                extra={"creative_id": r.creative_id},
                exc_info=True,
            )

    if count > 0:
        conn.commit()
        log.info("creative_retention_ingested", extra={"rows": count})

    return count


def fetch_and_ingest_meta_retention(
    conn: sqlite3.Connection,
    brand: str,
    date_start: str,
    date_stop: str,
) -> dict[str, Any]:
    """Fetch Meta retention metrics and ingest to mv_creative_daily.

    Skeleton implementation — returns empty result until Meta API
    credentials and thruplay data are configured.
    """
    # TODO: Call MetaInsightsClient to fetch creative-level retention metrics
    # meta = MetaInsightsClient(config)
    # raw = meta.get_creative_insights(
    #     date_start=date_start,
    #     date_stop=date_stop,
    #     fields=["impressions", "video_thruplay_watched_actions",
    #             "video_p100_watched_actions", "video_avg_time_watched_actions"],
    # )
    # rows = [CreativeRetentionRow(...) for r in raw]
    # count = ingest_creative_retention(conn, rows)

    log.info(
        "meta_retention_fetch_skeleton",
        extra={"brand": brand, "date_start": date_start, "date_stop": date_stop},
    )
    return {
        "ok": True,
        "skeleton": True,
        "brand": brand,
        "rows_ingested": 0,
    }
