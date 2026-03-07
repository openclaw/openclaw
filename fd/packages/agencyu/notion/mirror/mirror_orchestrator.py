"""Mirror orchestrator — coordinates all Notion mirror writers.

Enforces:
- Safe-mode default (simulate, never write)
- write_lock check from system_settings
- Cooldown / circuit-breaker awareness
- Per-run action cap (max_actions)
- Wall-clock runtime cap (max_runtime_s)
- Audit logging for every action
- Sync run telemetry
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.system_state import SystemState
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.orchestrator")


class MirrorWriter(Protocol):
    """Protocol for entity-based mirror writers (collect_pending + mirror_one)."""

    writer_name: str

    def collect_pending(self) -> list[dict[str, Any]]:
        """Collect entities that need mirroring."""
        ...

    def mirror_one(
        self,
        entity: dict[str, Any],
        *,
        safe_mode: bool,
        notion_api: NotionAPI,
        identity_store: IdentityMapStore,
    ) -> dict[str, Any]:
        """Mirror a single entity. Returns result dict with 'ok' key."""
        ...


class SourceWriter(Protocol):
    """Protocol for source-based writers (meetings, assets, SOP, team).

    These writers pull from external sources (GHL, Calendly, config)
    rather than from canonical_entities.
    """

    writer_name: str

    def mirror(
        self,
        sources: dict[str, Any],
        correlation_id: str,
        *,
        safe_mode: bool,
        max_writes: int,
    ) -> dict[str, Any]:
        """Mirror from external sources. Returns dict with 'writes' key."""
        ...


@dataclass
class OrchestratorConfig:
    """Controls for the mirror orchestrator."""

    safe_mode: bool = True
    max_actions: int = 200
    max_runtime_s: int = 300  # 5 minutes
    max_errors: int = 10


@dataclass
class RunStats:
    """Telemetry for a single orchestrator run."""

    actions: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0
    writers_run: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "actions": self.actions,
            "created": self.created,
            "updated": self.updated,
            "skipped": self.skipped,
            "errors": self.errors,
            "writers_run": self.writers_run,
        }


class MirrorOrchestrator:
    """Coordinates mirror writers with safety guardrails.

    Usage:
        orch = MirrorOrchestrator(conn, notion_api, config=OrchestratorConfig())
        orch.register(clients_writer)
        orch.register(tasks_writer)
        result = orch.run(correlation_id="sync_abc")
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: NotionAPI,
        *,
        config: OrchestratorConfig | None = None,
        audit_writer: AuditWriter | None = None,
    ) -> None:
        self.conn = conn
        self.notion_api = notion_api
        self.config = config or OrchestratorConfig()
        self.audit = audit_writer or AuditWriter(conn)
        self.identity_store = IdentityMapStore(conn)
        self.state = SystemState(conn)
        self._writers: list[MirrorWriter] = []
        self._source_writers: list[SourceWriter] = []
        self._portal_healer: Any = None
        self._child_block_healer: Any = None
        self._client_portals: list[dict[str, Any]] = []
        self._widget_writer: Any = None
        self._widget_data_provider: Any = None

    def register(self, writer: MirrorWriter) -> None:
        self._writers.append(writer)

    def register_source_writer(self, writer: SourceWriter) -> None:
        """Register a source-based writer (meetings, assets, SOP, team)."""
        self._source_writers.append(writer)

    def set_portal_healer(self, healer: Any) -> None:
        """Set portal block healer — property-text approach (called after clients mirror)."""
        self._portal_healer = healer

    def set_child_block_healer(
        self, healer: Any, client_portals: list[dict[str, Any]] | None = None
    ) -> None:
        """Set portal child-block healer — best-UX approach (headings + callouts).

        Args:
            healer: PortalChildBlockHealer instance.
            client_portals: List of dicts with portal_page_id, client_key, etc.
        """
        self._child_block_healer = healer
        self._client_portals = client_portals or []

    def set_widget_writer(
        self, writer: Any, data_provider: Any = None
    ) -> None:
        """Set the Command Center widget writer.

        Args:
            writer: NotionWidgetWriter instance.
            data_provider: Callable(WidgetSpec) -> dict with widget data.
        """
        self._widget_writer = writer
        self._widget_data_provider = data_provider

    def run(
        self,
        *,
        correlation_id: str = "",
        sources: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Execute a full mirror run across all registered writers.

        Args:
            correlation_id: Tracking ID for audit trail.
            sources: External source adapters dict (e.g. {"ghl": ..., "calendly": ...})
                     for source-based writers. Entity-based writers ignore this.
        """
        run_id = new_id("sync")
        start_ts = time.monotonic()
        now = utc_now_iso()
        stats = RunStats()
        sources = sources or {}

        # Record sync run start
        self.conn.execute(
            """INSERT INTO sync_runs (id, source_system, status, started_at)
               VALUES (?, 'mirror_orchestrator', 'running', ?)""",
            (run_id, now),
        )
        self.conn.commit()

        # ── Pre-flight checks ──
        stop_reason = self._preflight_check()
        if stop_reason:
            self._finish_run(run_id, "blocked", stats, stop_reason)
            self.audit.write_event(
                action="mirror.blocked",
                target_type="mirror_orchestrator",
                target_id=run_id,
                details={"reason": stop_reason},
                correlation_id=correlation_id,
                result="blocked",
                stop_reason=stop_reason,
            )
            return {"ok": False, "run_id": run_id, "stop_reason": stop_reason, **stats.to_dict()}

        effective_safe_mode = self.config.safe_mode or self.state.write_lock_active()

        all_writer_names = (
            [w.writer_name for w in self._writers]
            + [w.writer_name for w in self._source_writers]
        )
        log.info("mirror_run_start", extra={
            "run_id": run_id,
            "safe_mode": effective_safe_mode,
            "writers": all_writer_names,
        })

        # ── Run entity-based writers ──
        for writer in self._writers:
            if self._should_stop(stats, start_ts):
                break

            stats.writers_run.append(writer.writer_name)

            try:
                pending = writer.collect_pending()
            except Exception as exc:
                stats.errors += 1
                log.error("writer_collect_error", extra={
                    "writer": writer.writer_name, "error": str(exc),
                })
                continue

            for entity in pending:
                if self._should_stop(stats, start_ts):
                    break

                try:
                    result = writer.mirror_one(
                        entity,
                        safe_mode=effective_safe_mode,
                        notion_api=self.notion_api,
                        identity_store=self.identity_store,
                    )
                    stats.actions += 1

                    if result.get("created"):
                        stats.created += 1
                    elif result.get("updated"):
                        stats.updated += 1
                    elif result.get("skipped") or result.get("dry_run"):
                        stats.skipped += 1
                    elif result.get("error"):
                        stats.errors += 1

                except Exception as exc:
                    stats.actions += 1
                    stats.errors += 1
                    log.error("mirror_one_error", extra={
                        "writer": writer.writer_name,
                        "entity_id": entity.get("id", "?"),
                        "error": str(exc),
                    })

        # ── Run source-based writers ──
        for sw in self._source_writers:
            if self._should_stop(stats, start_ts):
                break

            stats.writers_run.append(sw.writer_name)
            remaining = max(0, self.config.max_actions - stats.actions)

            try:
                result = sw.mirror(
                    sources,
                    correlation_id,
                    safe_mode=effective_safe_mode,
                    max_writes=remaining,
                )
                w = result.get("writes", 0)
                stats.actions += w
                if effective_safe_mode:
                    stats.skipped += w
                else:
                    stats.created += w
            except Exception as exc:
                stats.errors += 1
                log.error("source_writer_error", extra={
                    "writer": sw.writer_name, "error": str(exc),
                })

        # ── Portal block healer (after clients mirror) ──
        if self._portal_healer and not self._should_stop(stats, start_ts):
            try:
                heal_result = self._portal_healer.heal_all_clients(
                    sources,
                    correlation_id,
                    safe_mode=effective_safe_mode,
                    max_clients=min(200, max(0, self.config.max_actions - stats.actions)),
                )
                hw = heal_result.get("writes", 0)
                stats.actions += hw
                stats.updated += hw
                stats.writers_run.append("portal_healer")
            except Exception as exc:
                stats.errors += 1
                log.error("portal_healer_error", extra={"error": str(exc)})

        # ── Portal child-block healer (best-UX, headings + callouts) ──
        if self._child_block_healer and not self._should_stop(stats, start_ts):
            try:
                cbh_result = self._child_block_healer.heal_all_clients(
                    self._client_portals,
                    correlation_id,
                    safe_mode=effective_safe_mode,
                    max_clients=min(200, max(0, self.config.max_actions - stats.actions)),
                )
                cbw = cbh_result.get("writes", 0)
                stats.actions += cbw
                stats.updated += cbw
                stats.writers_run.append("portal_child_block_healer")
            except Exception as exc:
                stats.errors += 1
                log.error("child_block_healer_error", extra={"error": str(exc)})

        # ── Command Center widgets ──
        if self._widget_writer and not self._should_stop(stats, start_ts):
            try:
                ww_result = self._widget_writer.write_all(
                    data_provider=self._widget_data_provider,
                    safe_mode=effective_safe_mode,
                    correlation_id=correlation_id,
                    max_writes=min(50, max(0, self.config.max_actions - stats.actions)),
                )
                ww = ww_result.get("writes", 0)
                stats.actions += ww
                stats.updated += ww
                stats.writers_run.append("command_center_widgets")
            except Exception as exc:
                stats.errors += 1
                log.error("widget_writer_error", extra={"error": str(exc)})

        # ── Finish ──
        status = "completed" if stats.errors == 0 else "completed_with_errors"
        self._finish_run(run_id, status, stats)

        self.audit.write_event(
            action="mirror.run_complete",
            target_type="mirror_orchestrator",
            target_id=run_id,
            details=stats.to_dict(),
            correlation_id=correlation_id,
            result="ok" if stats.errors == 0 else "partial",
        )

        log.info("mirror_run_complete", extra={
            "run_id": run_id,
            "total_actions": stats.actions,
            "total_created": stats.created,
            "total_updated": stats.updated,
            "total_skipped": stats.skipped,
            "total_errors": stats.errors,
        })
        return {"ok": True, "run_id": run_id, "safe_mode": effective_safe_mode, **stats.to_dict()}

    def _preflight_check(self) -> str | None:
        """Check all safety gates before running."""
        if settings.KILL_SWITCH:
            return "kill_switch_active"

        if self.state.cooldown_active():
            return "cooldown_active"

        queue = self.state.queue_depth()
        if queue > 100:
            return f"queue_depth_critical ({queue})"

        return None

    def _should_stop(self, stats: RunStats, start_ts: float) -> bool:
        """Check runtime and action caps."""
        if stats.actions >= self.config.max_actions:
            log.warning("mirror_action_cap_reached", extra={"max": self.config.max_actions})
            return True
        if stats.errors >= self.config.max_errors:
            log.warning("mirror_error_cap_reached", extra={"max": self.config.max_errors})
            return True
        elapsed = time.monotonic() - start_ts
        if elapsed >= self.config.max_runtime_s:
            log.warning("mirror_runtime_cap_reached", extra={"max_s": self.config.max_runtime_s})
            return True
        return False

    def _finish_run(
        self, run_id: str, status: str, stats: RunStats, error: str | None = None
    ) -> None:
        """Update sync_runs row with final status."""
        import json

        now = utc_now_iso()
        self.conn.execute(
            """UPDATE sync_runs SET status=?, finished_at=?, stats_json=?, error_text=?
               WHERE id=?""",
            (status, now, json.dumps(stats.to_dict()), error, run_id),
        )
        self.conn.commit()
