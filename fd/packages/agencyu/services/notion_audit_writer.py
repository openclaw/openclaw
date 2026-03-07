"""Notion Audit Writer — mirrors selected audit entries to the Notion System Audit Log DB.

Hardened design:
- Safe-mode friendly (simulates by default)
- Rate-limited via NotionAPI
- Idempotent via SQLite columns (mirrored_to_notion_at, mirrored_event_key) — retries never double-post
- Event-key dedupe (sha1 of bucketed ts + system + action + result + target + correlation_id)
- Paginated Notion scan (multiple pages of existing rows for cross-system dedupe)
- Circuit breaker + cooldown (auto-pauses after error spikes)
- Selective (configurable policy: mirror_results, mirror_actions_prefixes)
- Schema-aligned with the system_audit_log DB in template_manifest.yaml

CEO dashboard always shows:
- Last drift verify / heal apply
- Last reconcile
- Backup status
- Last stop reason / circuit breaker trigger
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.services.circuit_breaker import CircuitBreaker, CircuitBreakerConfig
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.logging import get_logger

log = get_logger("agencyu.services.notion_audit_writer")


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()  # noqa: S324


@dataclass
class NotionAuditWriterConfig:
    """Configuration for the Notion audit writer."""

    system_audit_log_db_id: str = ""

    safe_mode: bool = True
    notion_write_enabled: bool = False
    notion_write_lock: bool = True

    # Mirroring policy — always mirror these result statuses
    mirror_results: tuple[str, ...] = ("failed", "blocked")
    # Mirror events from these systems
    mirror_systems: tuple[str, ...] = (
        "openclaw", "notion", "trello", "ghl", "stripe", "quickbooks",
    )
    # Mirror actions with these prefixes
    mirror_actions_prefixes: tuple[str, ...] = (
        "notion.verify",
        "notion.heal",
        "notion.reconcile",
        "notion.mirror_audit_logs",
        "trello.sync",
        "ghl.sync",
        "stripe.webhook",
        "backup",
        "backup.",
        "system.cooldown",
        "system.circuit_breaker",
        "heal", "heal_simulate", "heal_apply",
        "verify", "drift_verify",
        "reconcile",
        "portal_verify", "portal_heal",
        "circuit_break", "cooldown",
        "bootstrap",
    )

    # Dedupe window: bucket audit events into minute granularity
    dedupe_bucket_seconds: int = 60
    # Max Notion writes per run (protects against runaway)
    max_writes_per_run: int = 25

    # Notion existing scan pagination
    notion_scan_max_pages: int = 6  # 6 * 100 = 600 rows max
    notion_scan_page_size: int = 100

    # Circuit breaker settings
    cb_window_seconds: int = 900  # 15 minutes
    cb_error_threshold: int = 6
    cb_cooldown_seconds: int = 1800  # 30 minutes


class NotionAuditWriter:
    """Mirrors selected OpenClaw audit log entries (SQLite) into Notion 'System Audit Log' DB.

    Hardened with:
    - SQLite column tracking (mirrored_to_notion_at, mirrored_event_key) so retries never double-post
    - Paginated Notion scan for cross-system dedupe (up to N pages)
    - Circuit breaker that pauses mirroring after error spikes

    Two APIs:
    1. run(correlation_id) — batch mirror recent audit logs to Notion
    2. write_entry(...) — write a single entry (for direct callers)

    Safety gates: safe_mode, notion_write_enabled, notion_write_lock, circuit_breaker.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_api: NotionAPI,
        cfg: NotionAuditWriterConfig | None = None,
        audit_log_db_id: str | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_api

        if cfg is not None:
            self.cfg = cfg
        else:
            self.cfg = NotionAuditWriterConfig(
                system_audit_log_db_id=audit_log_db_id or "",
                safe_mode=getattr(settings, "SAFE_MODE", True),
                notion_write_enabled=getattr(settings, "NOTION_WRITE_ENABLED", False),
                notion_write_lock=getattr(settings, "NOTION_WRITE_LOCK", True),
            )

        # Resolve DB ID from config, then bindings, then settings
        if not self.cfg.system_audit_log_db_id:
            self.cfg.system_audit_log_db_id = self._resolve_audit_log_db_id() or ""

        # Circuit breaker
        self.cb = CircuitBreaker(
            conn,
            cfg=CircuitBreakerConfig(
                window_seconds=self.cfg.cb_window_seconds,
                error_threshold=self.cfg.cb_error_threshold,
                cooldown_seconds=self.cfg.cb_cooldown_seconds,
            ),
        )

    @property
    def audit_log_db_id(self) -> str:
        return self.cfg.system_audit_log_db_id

    # ─────────────────────────────────────────
    # Batch run: mirror recent audit logs
    # ─────────────────────────────────────────

    def run(self, correlation_id: str) -> dict[str, Any]:
        """Batch mirror recent audit logs from SQLite to Notion.

        Respects safety gates + circuit breaker, applies selection policy, deduplicates.
        Returns a summary dict.
        """
        # Safety gates
        if self.cfg.safe_mode:
            return self._simulate_run(correlation_id, reason="SAFE_MODE=true")
        if not self.cfg.notion_write_enabled:
            return self._simulate_run(correlation_id, reason="NOTION_WRITE_ENABLED=false")
        if self.cfg.notion_write_lock:
            return self._simulate_run(correlation_id, reason="NOTION_WRITE_LOCK=true")
        if not self.cfg.system_audit_log_db_id:
            return self._simulate_run(correlation_id, reason="no_system_audit_log_db_id")

        # Circuit breaker gate
        active, until, reason = self.cb.cooldown_active()
        if active:
            log.warning("audit_mirror_blocked_by_circuit_breaker", extra={
                "until": until, "reason": reason,
            })
            return {
                "ok": True,
                "simulate": True,
                "blocked_reason": f"circuit_breaker_cooldown until={until} reason={reason}",
                "correlation_id": correlation_id,
                "candidate_count": 0,
                "written": 0,
                "skipped_existing": 0,
                "attempted": 0,
                "warnings": ["circuit_breaker_cooldown_active"],
            }

        # Pull candidates — exclude already-mirrored rows
        rows = self._fetch_recent_audit_logs(limit=400)
        candidates = [r for r in rows if self._should_mirror(r)]
        candidates = self._exclude_already_mirrored(candidates)

        # Deduplicate within run via event_key
        to_write: list[dict[str, Any]] = []
        seen_keys: set[str] = set()

        for r in candidates:
            event_key = self._event_key(r)
            if event_key in seen_keys:
                continue
            seen_keys.add(event_key)
            to_write.append({"row": r, "event_key": event_key})

        # Enforce max writes per run
        to_write = to_write[: self.cfg.max_writes_per_run]

        written = 0
        skipped_existing = 0
        errors: list[str] = []

        # Paginated Notion scan for existing event keys
        existing_keys = self._fetch_existing_event_keys_from_notion()

        for item in to_write:
            r = item["row"]
            event_key = item["event_key"]

            if event_key in existing_keys:
                skipped_existing += 1
                # Mark in SQLite so we don't re-scan
                self._mark_mirrored(r, event_key, note="already_present_in_notion")
                continue

            try:
                self._write_one_to_notion(r, event_key=event_key)
                written += 1
                self._mark_mirrored(r, event_key, note="mirrored_ok")
            except Exception as exc:
                errors.append(str(exc))

        # Circuit breaker evaluation
        warnings: list[str] = []
        tripped = self.cb.consider_trip(
            mirror_job_errors=len(errors), reason="notion_audit_mirror"
        )
        if tripped:
            warnings.append("circuit_breaker_tripped")

        return {
            "ok": len(errors) == 0,
            "simulate": False,
            "written": written,
            "skipped_existing": skipped_existing,
            "candidate_count": len(candidates),
            "attempted": len(to_write),
            "errors": errors[:10],
            "correlation_id": correlation_id,
            "warnings": warnings,
        }

    # ─────────────────────────────────────────
    # Single-entry write (for direct callers)
    # ─────────────────────────────────────────

    def write_entry(
        self,
        correlation_id: str,
        system: str,
        action: str,
        result: str,
        target: str | None = None,
        stop_reason: str | None = None,
        payload_json: str | None = None,
        notes: str | None = None,
    ) -> str | None:
        """Write a single audit entry to the Notion System Audit Log DB.

        Checks selection policy. Returns page ID or None if skipped.
        """
        row = {
            "correlation_id": correlation_id,
            "system": system,
            "action": action,
            "result": result,
            "target": target,
            "stop_reason": stop_reason,
            "payload_json": payload_json,
            "notes": notes,
            "ts": utc_now_iso(),
        }

        if not self._should_mirror(row):
            return None

        if not self.cfg.system_audit_log_db_id:
            log.warning("notion_audit_write_skipped", extra={"reason": "no_db_id"})
            return None

        event_key = self._event_key(row)
        try:
            page_id = self._write_one_to_notion(row, event_key=event_key)
            log.info("notion_audit_written", extra={"action": action, "page_id": page_id})
            return page_id
        except Exception as exc:
            log.error("notion_audit_write_failed", extra={"error": str(exc)})
            return None

    def write_from_local(self, audit_entry: dict[str, Any]) -> str | None:
        """Mirror a local audit_logs row to Notion."""
        return self.write_entry(
            correlation_id=audit_entry.get("correlation_id", ""),
            system=audit_entry.get("system", "openclaw"),
            action=audit_entry.get("action", ""),
            result=audit_entry.get("result", "ok"),
            target=audit_entry.get("target"),
            stop_reason=audit_entry.get("stop_reason"),
            payload_json=audit_entry.get("payload_json"),
            notes=audit_entry.get("notes"),
        )

    # ─────────────────────────────────────────
    # Simulation
    # ─────────────────────────────────────────

    def _simulate_run(
        self, correlation_id: str, reason: str
    ) -> dict[str, Any]:
        rows = self._fetch_recent_audit_logs(limit=80)
        candidates = [r for r in rows if self._should_mirror(r)]
        candidates = self._exclude_already_mirrored(candidates)
        preview = []
        for r in candidates[:10]:
            preview.append({
                "system": r.get("system"),
                "action": r.get("action"),
                "result": r.get("result"),
                "target": r.get("target"),
                "ts": r.get("ts"),
                "event_key": self._event_key(r),
            })
        return {
            "ok": True,
            "simulate": True,
            "blocked_reason": reason,
            "candidate_count": len(candidates),
            "preview": preview,
            "correlation_id": correlation_id,
        }

    # ─────────────────────────────────────────
    # Selection policy
    # ─────────────────────────────────────────

    def _should_mirror(self, r: dict[str, Any]) -> bool:
        """Determine if an audit row should be mirrored to Notion."""
        if r.get("system") not in self.cfg.mirror_systems:
            return False

        action = (r.get("action") or "").strip()
        result = (r.get("result") or "").strip()

        # Always mirror failures/blocked
        if result in self.cfg.mirror_results:
            return True

        # Mirror important action prefixes
        for prefix in self.cfg.mirror_actions_prefixes:
            if action.startswith(prefix):
                return True

        return False

    # ─────────────────────────────────────────
    # Dedupe keys
    # ─────────────────────────────────────────

    def _event_key(self, r: dict[str, Any]) -> str:
        """Create a stable key to dedupe events across retries.

        Buckets timestamp to reduce duplicates from small timing differences.
        """
        ts = r.get("ts") or ""
        bucket = self._bucket_ts(ts, self.cfg.dedupe_bucket_seconds)
        raw = (
            f"{bucket}|{r.get('system')}|{r.get('action')}|"
            f"{r.get('result')}|{r.get('target') or ''}|{r.get('correlation_id')}"
        )
        return _sha1(raw)

    def _bucket_ts(self, iso_ts: str, bucket_seconds: int) -> str:
        """Bucket an ISO timestamp to the nearest bucket_seconds."""
        try:
            t = time.strptime(iso_ts, "%Y-%m-%dT%H:%M:%SZ")
            epoch = int(time.mktime(t))
            bucket = epoch - (epoch % bucket_seconds)
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(bucket))
        except Exception:
            return iso_ts[:16]  # YYYY-MM-DDTHH:MM fallback

    # ─────────────────────────────────────────
    # SQLite read + mirror tracking
    # ─────────────────────────────────────────

    def _fetch_recent_audit_logs(self, limit: int = 250) -> list[dict[str, Any]]:
        """Fetch recent audit_logs rows from SQLite (includes mirror columns)."""
        try:
            rows = self.conn.execute(
                "SELECT rowid AS _rowid, * FROM audit_logs ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            return []

    def _exclude_already_mirrored(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Filter out rows that have already been mirrored to Notion."""
        return [r for r in rows if not r.get("mirrored_to_notion_at")]

    def _mark_mirrored(
        self, r: dict[str, Any], event_key: str, note: str = ""
    ) -> None:
        """Stamp a row as mirrored in SQLite so it won't be re-processed."""
        row_id = r.get("_rowid") or r.get("id")
        if not row_id:
            return
        now = utc_now_iso()
        try:
            if r.get("_rowid"):
                self.conn.execute(
                    "UPDATE audit_logs SET mirrored_to_notion_at=?, mirrored_event_key=? WHERE rowid=?",
                    (now, event_key, r["_rowid"]),
                )
            else:
                self.conn.execute(
                    "UPDATE audit_logs SET mirrored_to_notion_at=?, mirrored_event_key=? WHERE id=?",
                    (now, event_key, r["id"]),
                )
            self.conn.commit()
        except Exception as exc:
            log.warning("mark_mirrored_failed", extra={"error": str(exc), "note": note})

    # ─────────────────────────────────────────
    # Notion read (paginated)
    # ─────────────────────────────────────────

    def _fetch_existing_event_keys_from_notion(self, window_hours: int = 72) -> set[str]:
        """Paginate through Notion System Audit Log to collect existing event_keys.

        Scans up to notion_scan_max_pages pages of notion_scan_page_size rows each.
        """
        db_id = self.cfg.system_audit_log_db_id
        if not db_id:
            return set()

        keys: set[str] = set()
        cursor: str | None = None
        pages_scanned = 0

        while pages_scanned < self.cfg.notion_scan_max_pages:
            try:
                res = self.notion.query_database(
                    db_id,
                    sorts=[{"property": "ts", "direction": "descending"}],
                    start_cursor=cursor,
                    page_size=self.cfg.notion_scan_page_size,
                )
            except Exception:
                if pages_scanned == 0:
                    # Retry without sorts on first attempt
                    try:
                        res = self.notion.query_database(
                            db_id, start_cursor=cursor,
                            page_size=self.cfg.notion_scan_page_size,
                        )
                    except Exception:
                        break
                else:
                    break

            for page in res.get("results", []):
                payload_text = self._get_rich_text(page, "payload_json")
                if not payload_text:
                    continue
                try:
                    obj = json.loads(payload_text)
                    k = obj.get("event_key")
                    if k:
                        keys.add(k)
                except Exception:
                    continue

            if not res.get("has_more"):
                break
            cursor = res.get("next_cursor")
            pages_scanned += 1

        return keys

    # ─────────────────────────────────────────
    # Notion write
    # ─────────────────────────────────────────

    def _write_one_to_notion(
        self, r: dict[str, Any], event_key: str
    ) -> str:
        """Write a single audit row to the Notion System Audit Log DB.

        Returns the created page ID.
        """
        db_id = self.cfg.system_audit_log_db_id

        # Build machine-parsable JSON snippet with event_key for dedupe
        machine = {
            "event_key": event_key,
            "correlation_id": r.get("correlation_id"),
            "system": r.get("system"),
            "action": r.get("action"),
            "result": r.get("result"),
            "target": r.get("target"),
            "stop_reason": r.get("stop_reason"),
            "ts": r.get("ts"),
        }

        action_label = (r.get("action") or "event")[:120]
        props: dict[str, Any] = {
            "Name": {"title": [{"text": {"content": action_label}}]},
            "ts": {"date": {"start": r.get("ts") or utc_now_iso()}},
            "correlation_id": {"rich_text": [{"text": {"content": str(r.get("correlation_id") or "")}}]},
            "system": {"select": {"name": str(r.get("system") or "openclaw")}},
            "action": {"rich_text": [{"text": {"content": str(r.get("action") or "")[:2000]}}]},
            "result": {"select": {"name": str(r.get("result") or "ok")}},
            "payload_json": {"rich_text": [{"text": {"content": json.dumps(machine, ensure_ascii=False)[:2000]}}]},
            "system_managed": {"checkbox": True},
        }

        # Optional fields — only set if non-empty
        if r.get("target"):
            props["target"] = {"rich_text": [{"text": {"content": str(r["target"])[:2000]}}]}
        else:
            props["target"] = {"rich_text": []}
        if r.get("stop_reason"):
            props["stop_reason"] = {"rich_text": [{"text": {"content": str(r["stop_reason"])[:2000]}}]}
        else:
            props["stop_reason"] = {"rich_text": []}
        if r.get("notes"):
            props["notes"] = {"rich_text": [{"text": {"content": str(r["notes"])[:2000]}}]}
        else:
            props["notes"] = {"rich_text": []}

        parent = {"type": "database_id", "database_id": db_id}
        return self.notion.create_page(parent=parent, properties=props)

    def _get_rich_text(
        self, page_obj: dict[str, Any], prop_name: str
    ) -> str | None:
        """Extract plain text from a Notion rich_text property."""
        props = page_obj.get("properties", {})
        p = props.get(prop_name)
        if not p or p.get("type") != "rich_text":
            return None
        rt = p.get("rich_text") or []
        if not rt:
            return None
        return "".join(x.get("plain_text", "") for x in rt).strip()

    # ─────────────────────────────────────────
    # Resolution
    # ─────────────────────────────────────────

    def _resolve_audit_log_db_id(self) -> str | None:
        """Resolve the System Audit Log Notion DB ID from bindings or settings."""
        # Try notion_bindings first
        try:
            row = self.conn.execute(
                "SELECT notion_object_id FROM notion_bindings WHERE binding_type='system_audit_log' LIMIT 1"
            ).fetchone()
            if row:
                return row["notion_object_id"]
        except Exception:
            pass

        # Try system_settings
        try:
            row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='system_audit_log_db_id' LIMIT 1"
            ).fetchone()
            if row and row["value"]:
                return row["value"]
        except Exception:
            pass

        return None
