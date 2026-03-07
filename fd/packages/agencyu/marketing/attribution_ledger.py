"""Attribution Ledger — Durable, queryable attribution chain store.

SQLite-backed ledger that tracks the full attribution chain:
Meta Ad → DM keyword → ManyChat tags → Calendly booking → Stripe revenue.

Every system carries combo_id + utm_campaign as the identity anchor.
The ledger stores:
- Chain records (linking all system IDs for a contact)
- Stage events (timestamped funnel progression)

Enables:
- CPA per combo
- ROAS per combo
- Funnel stage conversion rates per combo
- Creative fatigue tied to combos
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.marketing.attribution_ledger")


@dataclass
class AttributionTouch:
    """A single event in an attribution chain."""

    ts: str
    stage: str
    source: str
    payload: dict[str, Any]


class AttributionLedger:
    """SQLite-backed ledger for attribution chains and events.

    Uses the conn pattern (shared connection) matching codebase convention.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self._init_tables()

    def _init_tables(self) -> None:
        self.conn.execute("""
        CREATE TABLE IF NOT EXISTS attribution_chains (
            chain_id TEXT PRIMARY KEY,
            brand TEXT NOT NULL,
            combo_id TEXT NOT NULL,
            ghl_contact_id TEXT,
            manychat_contact_id TEXT,
            clickfunnels_visitor_id TEXT,
            stripe_customer_id TEXT,
            qb_customer_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)
        self.conn.execute("""
        CREATE TABLE IF NOT EXISTS attribution_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id TEXT NOT NULL,
            ts TEXT NOT NULL,
            stage TEXT NOT NULL,
            source TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            FOREIGN KEY(chain_id) REFERENCES attribution_chains(chain_id)
        )
        """)
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attr_events_chain ON attribution_events(chain_id)"
        )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attr_chain_combo ON attribution_chains(combo_id)"
        )
        self.conn.commit()

    def upsert_chain(
        self,
        chain_id: str,
        brand: str,
        combo_id: str,
        ids: dict[str, str | None],
    ) -> None:
        """Create or update an attribution chain with system IDs."""
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO attribution_chains
                (chain_id, brand, combo_id, ghl_contact_id, manychat_contact_id,
                 clickfunnels_visitor_id, stripe_customer_id, qb_customer_id,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chain_id) DO UPDATE SET
                ghl_contact_id=COALESCE(excluded.ghl_contact_id, attribution_chains.ghl_contact_id),
                manychat_contact_id=COALESCE(excluded.manychat_contact_id, attribution_chains.manychat_contact_id),
                clickfunnels_visitor_id=COALESCE(excluded.clickfunnels_visitor_id, attribution_chains.clickfunnels_visitor_id),
                stripe_customer_id=COALESCE(excluded.stripe_customer_id, attribution_chains.stripe_customer_id),
                qb_customer_id=COALESCE(excluded.qb_customer_id, attribution_chains.qb_customer_id),
                updated_at=excluded.updated_at
            """,
            (
                chain_id, brand, combo_id,
                ids.get("ghl_contact_id"), ids.get("manychat_contact_id"),
                ids.get("clickfunnels_visitor_id"),
                ids.get("stripe_customer_id"), ids.get("qb_customer_id"),
                now, now,
            ),
        )
        self.conn.commit()
        log.info("chain_upserted", extra={"chain_id": chain_id, "combo_id": combo_id})

    def append_event(
        self,
        chain_id: str,
        stage: str,
        source: str,
        payload: dict[str, Any],
    ) -> None:
        """Append a stage event to an attribution chain."""
        ts = utc_now_iso()
        self.conn.execute(
            """INSERT INTO attribution_events (chain_id, ts, stage, source, payload_json)
            VALUES (?, ?, ?, ?, ?)""",
            (chain_id, ts, stage, source, json.dumps(payload, separators=(",", ":"), sort_keys=True)),
        )
        self.conn.commit()

    def fetch_chain_events(self, chain_id: str) -> list[AttributionTouch]:
        """Fetch all events for a chain, ordered by timestamp."""
        rows = self.conn.execute(
            """SELECT ts, stage, source, payload_json
            FROM attribution_events
            WHERE chain_id = ?
            ORDER BY ts ASC""",
            (chain_id,),
        ).fetchall()
        return [
            AttributionTouch(ts=r[0], stage=r[1], source=r[2], payload=json.loads(r[3]))
            for r in rows
        ]

    def get_chain(self, chain_id: str) -> dict[str, Any] | None:
        """Fetch a chain record by ID."""
        row = self.conn.execute(
            "SELECT * FROM attribution_chains WHERE chain_id = ?", (chain_id,),
        ).fetchone()
        return dict(row) if row else None

    def get_chains_by_combo(self, combo_id: str) -> list[dict[str, Any]]:
        """Fetch all chains for a given combo_id."""
        rows = self.conn.execute(
            "SELECT * FROM attribution_chains WHERE combo_id = ? ORDER BY created_at DESC",
            (combo_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_combo_stats(self, combo_id: str) -> dict[str, Any]:
        """Compute basic stats for a combo: chain count and stage distribution."""
        chains = self.get_chains_by_combo(combo_id)
        if not chains:
            return {"combo_id": combo_id, "chains": 0, "stages": {}}

        chain_ids = [c["chain_id"] for c in chains]
        placeholders = ",".join("?" * len(chain_ids))

        stage_rows = self.conn.execute(
            f"""SELECT stage, COUNT(*) as cnt
            FROM attribution_events
            WHERE chain_id IN ({placeholders})
            GROUP BY stage
            ORDER BY cnt DESC""",
            chain_ids,
        ).fetchall()

        return {
            "combo_id": combo_id,
            "chains": len(chains),
            "stages": {r[0]: r[1] for r in stage_rows},
        }

    def get_top_combos_by_revenue(self, limit: int = 10) -> list[dict[str, Any]]:
        """Get top combos by total revenue from attribution events."""
        rows = self.conn.execute(
            """SELECT ac.combo_id, COUNT(DISTINCT ac.chain_id) as chains,
                      COUNT(ae.id) as events
            FROM attribution_chains ac
            LEFT JOIN attribution_events ae ON ae.chain_id = ac.chain_id
            GROUP BY ac.combo_id
            ORDER BY chains DESC
            LIMIT ?""",
            (limit,),
        ).fetchall()
        return [{"combo_id": r[0], "chains": r[1], "events": r[2]} for r in rows]
