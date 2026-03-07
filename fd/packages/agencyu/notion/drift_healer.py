from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.manifest_validator import DriftIssue, NotionManifestValidator
from packages.common.clock import utc_now_iso
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.drift_healer")


# ── Legacy dataclasses (backwards-compatible) ──


@dataclass
class HealAction:
    database: str
    action: str  # add_property / add_option / skip / create_database / bootstrap_system
    property_name: str | None
    details: str
    success: bool = False
    error: str | None = None


@dataclass
class HealResult:
    dry_run: bool
    actions: list[HealAction] = field(default_factory=list)
    healed_count: int = 0
    skipped_count: int = 0
    error_count: int = 0


# ── Enhanced HealPlan for simulate/apply pattern ──


@dataclass
class HealPlanAction:
    """A planned healing action with full payload."""

    action_type: str  # create_database / add_property / add_select_options / bootstrap_settings / bootstrap_views
    database_key: str
    target_id: str | None
    payload: dict[str, Any]
    description: str


@dataclass
class HealPlan:
    """A complete healing plan that can be simulated or applied."""

    ok_to_apply: bool
    actions: list[HealPlanAction] = field(default_factory=list)
    blocked_reasons: list[str] = field(default_factory=list)
    manifest_hash: str = ""
    generated_at: str = ""


class DriftHealer:
    """Auto-heals healable drift issues detected by the manifest validator.

    Two APIs:
    1. heal() — legacy, backwards-compatible
    2. simulate() / apply() — enhanced HealPlan pattern with system bootstrap

    Safe-mode rules:
    - Never changes property types (manual intervention required)
    - Never deletes properties
    - Never modifies Trello truth fields
    - Respects DRY_RUN, NOTION_WRITE_ENABLED, NOTION_WRITE_LOCK, KILL_SWITCH
    - Logs all actions to system_snapshots + system_audit_log
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion: NotionClient,
        validator: NotionManifestValidator | None = None,
        manifest_path: str | Path | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion
        self.validator = validator or NotionManifestValidator(conn, notion)
        if manifest_path is None:
            manifest_path = Path(__file__).parent / "template_manifest.yaml"
        self.manifest = yaml.safe_load(Path(manifest_path).read_text())

    def _can_write(self) -> bool:
        return (
            settings.NOTION_WRITE_ENABLED
            and not settings.DRY_RUN
            and not settings.KILL_SWITCH
            and not getattr(settings, "NOTION_WRITE_LOCK", False)
        )

    # ── Legacy API (backwards-compatible) ──

    def heal(self, issues: list[DriftIssue] | None = None) -> HealResult:
        """Attempt to heal all healable issues."""
        if issues is None:
            result = self.validator.validate()
            issues = result.issues

        healable = [i for i in issues if i.healable]
        non_healable = [i for i in issues if not i.healable]

        if not self._can_write():
            actions = []
            for issue in healable:
                actions.append(HealAction(
                    database=issue.database,
                    action=self._action_for_issue(issue),
                    property_name=issue.property_name,
                    details=f"[DRY_RUN] Would heal: {issue.details}",
                ))
            for issue in non_healable:
                actions.append(HealAction(
                    database=issue.database,
                    action="skip",
                    property_name=issue.property_name,
                    details=f"[MANUAL] {issue.details}",
                ))

            return HealResult(dry_run=True, actions=actions, healed_count=0, skipped_count=len(non_healable))

        heal_result = HealResult(dry_run=False)
        for issue in healable:
            action = self._heal_issue(issue)
            heal_result.actions.append(action)
            if action.success:
                heal_result.healed_count += 1
            elif action.error:
                heal_result.error_count += 1

        for issue in non_healable:
            heal_result.actions.append(HealAction(
                database=issue.database, action="skip",
                property_name=issue.property_name, details=f"[MANUAL] {issue.details}",
            ))
            heal_result.skipped_count += 1

        self._record_heal_snapshot(heal_result)
        return heal_result

    # ── Enhanced HealPlan API ──

    def simulate(self, drift_issues: list[DriftIssue] | None = None) -> HealPlan:
        """Generate a heal plan without executing anything."""
        if drift_issues is None:
            result = self.validator.validate()
            drift_issues = result.issues
        return self._build_plan(drift_issues)

    def apply(self, drift_issues: list[DriftIssue] | None = None, correlation_id: str = "") -> HealPlan:
        """Generate and execute a heal plan.

        Blocks if safety flags prevent writes or CRITICAL wrong_type issues exist.
        """
        if drift_issues is None:
            result = self.validator.validate()
            drift_issues = result.issues

        plan = self._build_plan(drift_issues)

        if not self._can_write():
            reasons = []
            if settings.DRY_RUN:
                reasons.append("DRY_RUN=true")
            if settings.SAFE_MODE:
                reasons.append("SAFE_MODE=true")
            if not settings.NOTION_WRITE_ENABLED:
                reasons.append("NOTION_WRITE_ENABLED=false")
            if getattr(settings, "NOTION_WRITE_LOCK", False):
                reasons.append("NOTION_WRITE_LOCK=true")
            if settings.KILL_SWITCH:
                reasons.append("KILL_SWITCH=true")
            plan.blocked_reasons.extend(reasons)
            plan.ok_to_apply = False
            return plan

        if not plan.ok_to_apply:
            return plan

        for act in plan.actions:
            self._execute_plan_action(act)

        self._record_plan_snapshot(plan, correlation_id)
        self._record_audit_entry(
            correlation_id=correlation_id or new_id("corr"),
            system="openclaw", action="heal", target="notion_workspace",
            result="success", details=f"Applied {len(plan.actions)} heal actions",
        )
        return plan

    def _build_plan(self, drift_issues: list[DriftIssue]) -> HealPlan:
        now = utc_now_iso()
        manifest_hash = self._hash_manifest()
        actions: list[HealPlanAction] = []
        blocked: list[str] = []
        db_specs = self.manifest.get("databases", {})

        if any(i.issue_type == "wrong_type" for i in drift_issues):
            blocked.append("CRITICAL: wrong_type drift detected — manual fix required before apply")

        for issue in drift_issues:
            if issue.issue_type == "missing_database":
                spec = db_specs.get(issue.database)
                if spec:
                    actions.append(HealPlanAction(
                        action_type="create_database", database_key=issue.database,
                        target_id=None, payload=self._payload_create_database(issue.database, spec),
                        description=f"Create missing database '{issue.database}'",
                    ))

        for issue in drift_issues:
            if issue.issue_type == "missing_property" and issue.property_name:
                prop_spec = db_specs.get(issue.database, {}).get("properties", {}).get(issue.property_name)
                if prop_spec:
                    actions.append(HealPlanAction(
                        action_type="add_property", database_key=issue.database,
                        target_id=None, payload=self._payload_add_property(issue.property_name, prop_spec),
                        description=f"Add property '{issue.property_name}' to '{issue.database}'",
                    ))

        for issue in drift_issues:
            if issue.issue_type in ("missing_option", "missing_select_options") and issue.property_name:
                prop_spec = db_specs.get(issue.database, {}).get("properties", {}).get(issue.property_name, {})
                actions.append(HealPlanAction(
                    action_type="add_select_options", database_key=issue.database,
                    target_id=None, payload=self._payload_add_select_options(issue.property_name, prop_spec),
                    description=f"Add select options for '{issue.property_name}' on '{issue.database}'",
                ))

        actions.extend(self._bootstrap_system_tables())

        return HealPlan(
            ok_to_apply=len(blocked) == 0, actions=actions, blocked_reasons=blocked,
            manifest_hash=manifest_hash, generated_at=now,
        )

    def _execute_plan_action(self, action: HealPlanAction) -> None:
        db_id = self._resolve_db_id(action.database_key)

        if action.action_type == "create_database":
            root_page_id = settings.NOTION_ROOT_PAGE_ID
            if not root_page_id:
                return
            try:
                self.notion._limiter.acquire()
                resp = self.notion._client.post(
                    f"{self.notion.base_url}/databases",
                    json={
                        "parent": {"type": "page_id", "page_id": root_page_id},
                        "title": [{"type": "text", "text": {"content": action.payload.get("title", "")}}],
                        "properties": action.payload.get("properties", {}),
                    },
                    headers=self.notion._headers(),
                )
                resp.raise_for_status()
                new_db_id = resp.json().get("id")
                self.conn.execute(
                    "INSERT OR REPLACE INTO notion_bindings (id, binding_type, notion_object_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (new_id("nb"), action.database_key, new_db_id, utc_now_iso(), utc_now_iso()),
                )
                self.conn.commit()
            except Exception as exc:
                log.error("database_create_failed", extra={"db_key": action.database_key, "error": str(exc)})
            return

        if action.action_type == "add_property" and db_id:
            try:
                self.notion._limiter.acquire()
                resp = self.notion._client.patch(
                    f"{self.notion.base_url}/databases/{db_id}",
                    json=action.payload, headers=self.notion._headers(),
                )
                resp.raise_for_status()
            except Exception as exc:
                log.error("property_add_failed", extra={"error": str(exc)})
            return

        if action.action_type == "add_select_options" and db_id:
            prop_name = action.payload.get("property_name", "")
            options = action.payload.get("options", [])
            prop_type = action.payload.get("type", "select")
            try:
                self.notion._limiter.acquire()
                resp = self.notion._client.patch(
                    f"{self.notion.base_url}/databases/{db_id}",
                    json={"properties": {prop_name: {prop_type: {"options": [{"name": o} for o in options]}}}},
                    headers=self.notion._headers(),
                )
                resp.raise_for_status()
            except Exception as exc:
                log.error("select_options_add_failed", extra={"error": str(exc)})
            return

        if action.action_type == "bootstrap_settings":
            self._bootstrap_settings_record(action.payload)
            return

        if action.action_type == "bootstrap_views":
            self._bootstrap_views_row(action.payload)

    def _bootstrap_system_tables(self) -> list[HealPlanAction]:
        actions: list[HealPlanAction] = []

        if "system_settings" in self.manifest.get("databases", {}):
            settings_payload: dict[str, Any] = {
                "template_version": self.manifest.get("version", "2.0"),
                "os_version": self.manifest.get("version", "2.0"),
                "write_lock": "true",
                "manifest_hash": self._hash_manifest(),
            }
            # Resolve and store DB IDs for views_registry and system_audit_log
            vr_id = self._resolve_db_id("views_registry")
            if vr_id:
                settings_payload["views_registry_db_id"] = vr_id
            sal_id = self._resolve_db_id("system_audit_log")
            if sal_id:
                settings_payload["system_audit_log_db_id"] = sal_id

            actions.append(HealPlanAction(
                action_type="bootstrap_settings", database_key="system_settings",
                target_id=None, payload=settings_payload,
                description="Ensure system_settings record exists",
            ))

            # Heal capacity override inconsistency: if override checked but
            # expires_at missing, auto-uncheck override in safe-mode
            actions.extend(self._heal_capacity_override_inconsistency())

        if "views_registry" in self.manifest.get("databases", {}):
            for db_key, spec in self.manifest.get("databases", {}).items():
                for view_name in spec.get("required_views", []):
                    actions.append(HealPlanAction(
                        action_type="bootstrap_views", database_key="views_registry",
                        target_id=None, payload={"database_key": db_key, "view_name": view_name},
                        description=f"Upsert view: {db_key}/{view_name}",
                    ))

        return actions

    def _heal_capacity_override_inconsistency(self) -> list[HealPlanAction]:
        """If capacity_override_ok_to_scale is on but expires_at is missing, uncheck override."""
        actions: list[HealPlanAction] = []
        try:
            override_row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='capacity_override_ok_to_scale'"
            ).fetchone()
            expires_row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='capacity_override_expires_at'"
            ).fetchone()
        except Exception:
            return actions

        override_on = override_row and str(override_row[0]).lower() in ("true", "1", "yes")
        expires_val = expires_row[0] if expires_row else None

        if override_on and not expires_val:
            log.warning("capacity_override_inconsistent", extra={
                "override_on": True, "expires_at": None,
            })
            actions.append(HealPlanAction(
                action_type="bootstrap_settings",
                database_key="system_settings",
                target_id=None,
                payload={"capacity_override_ok_to_scale": "false"},
                description="Auto-uncheck capacity_override_ok_to_scale (expires_at missing)",
            ))

        return actions

    def _bootstrap_settings_record(self, payload: dict[str, Any]) -> None:
        now = utc_now_iso()
        for key, value in payload.items():
            self.conn.execute(
                "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, str(value), now),
            )
        self.conn.commit()

    def _bootstrap_views_row(self, payload: dict[str, Any]) -> None:
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO views_registry
               (id, database_key, view_name, required, status, created_at, updated_at)
               VALUES (?, ?, ?, 1, 'unknown', ?, ?)
               ON CONFLICT(database_key, view_name) DO UPDATE SET required=1, updated_at=excluded.updated_at""",
            (new_id("vr"), payload["database_key"], payload["view_name"], now, now),
        )
        self.conn.commit()

    # ── Payload builders ──

    def _payload_create_database(self, db_key: str, spec: dict[str, Any]) -> dict[str, Any]:
        title = spec.get("title") or db_key.replace("_", " ").title()
        props: dict[str, Any] = {}
        for prop_name, prop_spec in spec.get("properties", {}).items():
            props[prop_name] = self._build_property_config(prop_spec["type"]) or {}
        return {"title": title, "properties": props}

    def _payload_add_property(self, prop_name: str, prop_spec: dict[str, Any]) -> dict[str, Any]:
        config = self._build_property_config(prop_spec["type"]) or {"rich_text": {}}
        return {"properties": {prop_name: config}}

    def _payload_add_select_options(self, prop_name: str, prop_spec: dict[str, Any]) -> dict[str, Any]:
        return {"property_name": prop_name, "options": prop_spec.get("options", []), "type": prop_spec.get("type", "select")}

    def _action_for_issue(self, issue: DriftIssue) -> str:
        if issue.issue_type == "missing_property":
            return "add_property"
        if issue.issue_type == "missing_option":
            return "add_option"
        return "skip"

    def _heal_issue(self, issue: DriftIssue) -> HealAction:
        db_id = self._resolve_db_id(issue.database)
        if not db_id:
            return HealAction(database=issue.database, action="skip", property_name=issue.property_name, details="Cannot heal: database not bound", success=False, error="no_binding")
        if issue.issue_type == "missing_property":
            return self._add_property(db_id, issue)
        if issue.issue_type == "missing_option":
            return self._add_select_option(db_id, issue)
        return HealAction(database=issue.database, action="skip", property_name=issue.property_name, details=f"Cannot auto-heal: {issue.issue_type}")

    def _add_property(self, db_id: str, issue: DriftIssue) -> HealAction:
        prop_name = issue.property_name or ""
        prop_type = self._extract_type_from_details(issue.details)
        config = self._build_property_config(prop_type)
        if not config:
            return HealAction(database=issue.database, action="add_property", property_name=prop_name, details=f"Unsupported type: {prop_type}", success=False, error="unsupported_type")
        try:
            self.notion._limiter.acquire()
            resp = self.notion._client.patch(f"{self.notion.base_url}/databases/{db_id}", json={"properties": {prop_name: config}}, headers=self.notion._headers())
            resp.raise_for_status()
            return HealAction(database=issue.database, action="add_property", property_name=prop_name, details=f"Added '{prop_name}' (type: {prop_type})", success=True)
        except Exception as exc:
            return HealAction(database=issue.database, action="add_property", property_name=prop_name, details=f"Failed: {exc}", success=False, error=str(exc))

    def _add_select_option(self, db_id: str, issue: DriftIssue) -> HealAction:
        prop_name = issue.property_name or ""
        option_name = ""
        if "'" in issue.details:
            parts = issue.details.split("'")
            if len(parts) >= 2:
                option_name = parts[1]
        if not option_name:
            return HealAction(database=issue.database, action="add_option", property_name=prop_name, details="Cannot parse option", success=False, error="parse_error")
        try:
            self.notion._limiter.acquire()
            resp = self.notion._client.patch(f"{self.notion.base_url}/databases/{db_id}", json={"properties": {prop_name: {"select": {"options": [{"name": option_name}]}}}}, headers=self.notion._headers())
            resp.raise_for_status()
            return HealAction(database=issue.database, action="add_option", property_name=prop_name, details=f"Added option '{option_name}'", success=True)
        except Exception as exc:
            return HealAction(database=issue.database, action="add_option", property_name=prop_name, details=f"Failed: {exc}", success=False, error=str(exc))

    def _build_property_config(self, prop_type: str) -> dict[str, Any] | None:
        configs: dict[str, dict[str, Any]] = {
            "title": {"title": {}}, "rich_text": {"rich_text": {}}, "number": {"number": {"format": "number"}},
            "select": {"select": {"options": []}}, "multi_select": {"multi_select": {"options": []}},
            "date": {"date": {}}, "checkbox": {"checkbox": {}}, "url": {"url": {}},
            "email": {"email": {}}, "phone_number": {"phone_number": {}},
        }
        return configs.get(prop_type)

    def _extract_type_from_details(self, details: str) -> str:
        if "(type: " in details:
            return details.split("(type: ")[1].rstrip(")")
        if "(expected type: " in details:
            return details.split("(expected type: ")[1].rstrip(").")
        return "rich_text"

    def _resolve_db_id(self, db_key: str) -> str | None:
        row = self.conn.execute("SELECT notion_object_id FROM notion_bindings WHERE binding_type=? LIMIT 1", (db_key,)).fetchone()
        return row["notion_object_id"] if row else None

    def _hash_manifest(self) -> str:
        return hashlib.sha256(json.dumps(self.manifest, sort_keys=True).encode("utf-8")).hexdigest()[:16]

    def _record_heal_snapshot(self, result: HealResult) -> None:
        now = utc_now_iso()
        try:
            self.conn.execute("INSERT OR REPLACE INTO system_snapshots (key, value_json, snapshot_type, created_at) VALUES (?, ?, 'drift_heal', ?)",
                              ("last_drift_heal", json.dumps({"healed": result.healed_count, "skipped": result.skipped_count, "errors": result.error_count}), now))
            self.conn.commit()
        except Exception:
            pass

    def _record_plan_snapshot(self, plan: HealPlan, correlation_id: str) -> None:
        now = utc_now_iso()
        try:
            self.conn.execute("INSERT OR REPLACE INTO system_snapshots (key, value_json, snapshot_type, created_at) VALUES (?, ?, 'heal_plan', ?)",
                              ("last_heal_plan", json.dumps({"ok_to_apply": plan.ok_to_apply, "actions": len(plan.actions), "manifest_hash": plan.manifest_hash, "correlation_id": correlation_id}), now))
            self.conn.execute("INSERT INTO system_settings (key, value, updated_at) VALUES ('last_heal_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", (now, now))
            self.conn.commit()
        except Exception:
            pass

    def _record_audit_entry(self, *, correlation_id: str, system: str, action: str, target: str, result: str, details: str = "", stop_reason: str = "") -> None:
        now = utc_now_iso()
        try:
            self.conn.execute("INSERT INTO system_audit_log (id, correlation_id, system, action, target, result, details, stop_reason, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                              (new_id("aud"), correlation_id, system, action, target, result, details, stop_reason, now, now))
            self.conn.commit()
        except Exception:
            pass
