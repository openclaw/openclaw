from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.sync.orchestrator")


class SyncOrchestrator:
    """Coordinates sync runs across connectors.

    Suggested order:
    1) Compliance check (verify Notion workspace schema)
    2) Trello mirror → canonical → Notion Tasks
    3) CRM (GHL/ClickFunnels/ManyChat/Calendly) → canonical → Notion CRM/Meetings
    4) Stripe → canonical → Notion Invoices/Clients MRR
    5) QuickBooks → canonical → Notion Invoices/Expenses
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def start_run(self, source_system: str) -> str:
        """Start a new sync run. Returns run ID."""
        run_id = new_id("sr")
        now = utc_now_iso()
        self.conn.execute(
            "INSERT INTO sync_runs (id, source_system, status, started_at) VALUES (?, ?, 'running', ?)",
            (run_id, source_system, now),
        )
        self.conn.commit()
        log.info("sync_run_started", extra={"run_id": run_id, "source": source_system})
        return run_id

    def finish_run(
        self, run_id: str, *, status: str = "success", stats: dict[str, Any] | None = None, error: str | None = None
    ) -> None:
        """Complete a sync run."""
        now = utc_now_iso()
        self.conn.execute(
            "UPDATE sync_runs SET status=?, finished_at=?, stats_json=?, error_text=? WHERE id=?",
            (status, now, json.dumps(stats) if stats else None, error, run_id),
        )
        self.conn.commit()
        log.info("sync_run_finished", extra={"run_id": run_id, "status": status})

    def record_conflict(
        self,
        *,
        sync_run_id: str | None,
        entity_id: str,
        entity_type: str,
        field_name: str,
        policy_applied: str,
        source_value: Any = None,
        notion_value: Any = None,
        resolved_value: Any = None,
    ) -> str:
        """Record a drift conflict for human review."""
        conflict_id = new_id("cl")
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO conflict_log
               (id, sync_run_id, entity_id, entity_type, field_name, policy_applied,
                source_value_json, notion_value_json, resolved_value_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                conflict_id, sync_run_id, entity_id, entity_type, field_name, policy_applied,
                json.dumps(source_value) if source_value is not None else None,
                json.dumps(notion_value) if notion_value is not None else None,
                json.dumps(resolved_value) if resolved_value is not None else None,
                now,
            ),
        )
        self.conn.commit()
        log.info("conflict_recorded", extra={"conflict_id": conflict_id, "entity_id": entity_id})
        return conflict_id

    def get_recent_runs(self, *, limit: int = 20) -> list[dict[str, Any]]:
        """Get recent sync runs."""
        rows = self.conn.execute(
            "SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_conflicts(self, *, entity_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        """Get recent conflicts, optionally filtered by entity."""
        if entity_id:
            rows = self.conn.execute(
                "SELECT * FROM conflict_log WHERE entity_id=? ORDER BY created_at DESC LIMIT ?",
                (entity_id, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM conflict_log ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_sync_overview(self) -> dict[str, Any]:
        """Get a high-level sync overview for the admin dashboard."""
        total_entities = self.conn.execute("SELECT COUNT(*) FROM canonical_entities WHERE is_deleted=0").fetchone()[0]
        total_mappings = self.conn.execute("SELECT COUNT(*) FROM entity_mappings").fetchone()[0]
        total_conflicts = self.conn.execute("SELECT COUNT(*) FROM conflict_log").fetchone()[0]

        # Last run per source
        sources = self.conn.execute(
            "SELECT DISTINCT source_system FROM sync_runs"
        ).fetchall()
        last_runs: dict[str, Any] = {}
        for s in sources:
            src = s["source_system"]
            run = self.conn.execute(
                "SELECT * FROM sync_runs WHERE source_system=? ORDER BY started_at DESC LIMIT 1",
                (src,),
            ).fetchone()
            if run:
                last_runs[src] = dict(run)

        return {
            "canonical_entities": total_entities,
            "entity_mappings": total_mappings,
            "unresolved_conflicts": total_conflicts,
            "last_runs_by_source": last_runs,
        }
