"""Minimal seed data — idempotent, safe to run repeatedly.

Inserts a few baseline attribution events and a fatigue placeholder
so the views/gates pipeline can be validated end-to-end on a fresh DB.

Uses INSERT OR IGNORE with deterministic external_id keys for idempotency.

Usage::

    python -m packages.db.seed --db ./data/openclaw.db
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone


def seed(db_path: str) -> None:
    """Insert minimal seed data into the given database."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        demo_rows = [
            {
                "event_ts": now,
                "brand": "fulldigital",
                "combo_id": "combo:bootstrap",
                "event_name": "pipeline_quality",
                "source": "seed",
                "external_id": "seed:fulldigital:pipeline_quality",
                "payload_json": json.dumps({"quality": 0.75}),
            },
            {
                "event_ts": now,
                "brand": "cutmv",
                "combo_id": "combo:bootstrap",
                "event_name": "trial_started",
                "source": "seed",
                "external_id": "seed:cutmv:trial_started",
                "payload_json": json.dumps({"note": "bootstrap seed"}),
            },
        ]

        for r in demo_rows:
            conn.execute(
                """
                INSERT OR IGNORE INTO attribution_events
                    (event_ts, brand, combo_id, event_name, source, external_id, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    r["event_ts"],
                    r["brand"],
                    r["combo_id"],
                    r["event_name"],
                    r["source"],
                    r["external_id"],
                    r["payload_json"],
                ),
            )

        # Fatigue placeholder (so views never return empty on bootstrap combo)
        conn.execute(
            """
            INSERT INTO angle_fatigue_scores
                (as_of_ts, brand, combo_id, fatigue_score, payload_json)
            SELECT ?, 'fulldigital', 'combo:bootstrap', 0.0, '{}'
            WHERE NOT EXISTS (
                SELECT 1 FROM angle_fatigue_scores
                WHERE brand = 'fulldigital' AND combo_id = 'combo:bootstrap'
            )
            """,
            (now,),
        )

        conn.commit()
        print("[OK] seed complete")
    finally:
        conn.close()


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Seed minimal bootstrap data")
    parser.add_argument("--db", required=True, help="Path to SQLite DB file")
    args = parser.parse_args()
    seed(args.db)


if __name__ == "__main__":
    _cli()
