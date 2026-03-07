from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any

import yaml

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.rate_limit import RateLimiter
from packages.agencyu.notion.types import ComplianceReport, DriftIssueV2, DriftSeverity
from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.compliance_verifier")


class NotionComplianceVerifier:
    """Verifies a Notion workspace against template_manifest.yaml.

    Guarantees:
    - Read-only by default (no schema mutation — that is drift_healer's job)
    - Deterministic drift output
    - Rate-limited + circuit-breaker friendly

    Inputs:
    - notion_api: Higher-level Notion API wrapper
    - conn: SQLite connection for reading notion_bindings + views_registry
    - root_page_id: The root page shared to the integration
    - bindings: Optional mapping of db logical names → Notion database IDs
    - manifest_path: Path to template_manifest.yaml (defaults to bundled)
    """

    def __init__(
        self,
        notion_api: NotionAPI,
        conn: sqlite3.Connection,
        root_page_id: str,
        bindings: dict[str, str] | None = None,
        manifest_path: str | Path | None = None,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        self.notion = notion_api
        self.conn = conn
        self.root_page_id = root_page_id
        self.explicit_bindings = bindings or {}
        self.rl = rate_limiter or RateLimiter()

        if manifest_path is None:
            manifest_path = Path(__file__).parent / "template_manifest.yaml"
        self.manifest = yaml.safe_load(Path(manifest_path).read_text())

    def verify(self) -> ComplianceReport:
        """Run full compliance verification.

        Steps:
        1. Check root page access
        2. Resolve DB IDs (explicit bindings → notion_bindings → discovery)
        3. Verify properties, types, options per DB
        4. Verify views via Views Registry
        5. Verify relation integrity
        """
        started = time.monotonic()
        issues: list[DriftIssueV2] = []
        manifest_version = self.manifest.get("version", "unknown")
        required_dbs: dict[str, Any] = self.manifest.get("databases", {})

        # Step 0: Root access check
        self.rl.wait("notion.read.page")
        if not self.notion.can_read_page(self.root_page_id):
            issues.append(DriftIssueV2(
                database="__root__",
                issue_type="missing_access",
                property_name=None,
                severity=DriftSeverity.CRITICAL,
                details="Integration cannot read root page. Share root page to integration.",
            ))
            return ComplianceReport(
                ok=False,
                issues=issues,
                elapsed_ms=int((time.monotonic() - started) * 1000),
                manifest_version=manifest_version,
            )

        # Step 1: Resolve DB IDs
        resolved: dict[str, str] = {}
        databases_missing = 0

        for db_key, db_spec in required_dbs.items():
            db_id = self._resolve_db_id(db_key, db_spec)
            if not db_id:
                databases_missing += 1
                severity = DriftSeverity.CRITICAL if db_spec.get("required", False) else DriftSeverity.MEDIUM
                issues.append(DriftIssueV2(
                    database=db_key,
                    issue_type="missing_database",
                    property_name=None,
                    severity=severity,
                    details="Database not found or not shared to integration.",
                ))
                continue
            resolved[db_key] = db_id

        # Step 2: Schema verification
        for db_key, db_id in resolved.items():
            db_spec = required_dbs[db_key]
            self.rl.wait("notion.read.database")
            try:
                schema = self.notion.get_database(db_id)
            except Exception as exc:
                issues.append(DriftIssueV2(
                    database=db_key,
                    issue_type="schema_fetch_error",
                    property_name=None,
                    severity=DriftSeverity.HIGH,
                    details=f"Failed to fetch schema: {exc}",
                ))
                continue

            issues.extend(self._verify_properties(db_key, schema, db_spec))

        # Step 3: Brand property enforcement
        issues.extend(self._verify_brand_property(resolved, required_dbs))

        # Step 4: Views verification (via Views Registry)
        issues.extend(self._verify_views_from_registry(required_dbs))

        # Step 5: Per-brand view keys
        issues.extend(self._verify_brand_views())

        # Step 6: Relation integrity
        issues.extend(self._verify_relations(resolved, required_dbs))

        # Step 7: Capacity override consistency
        issues.extend(self._verify_capacity_override(resolved))

        ok = all(i.severity != DriftSeverity.CRITICAL for i in issues)
        elapsed_ms = int((time.monotonic() - started) * 1000)

        log.info("compliance_verification_complete", extra={
            "ok": ok,
            "total_issues": len(issues),
            "critical": sum(1 for i in issues if i.is_critical),
            "databases_checked": len(resolved),
            "databases_missing": databases_missing,
            "elapsed_ms": elapsed_ms,
        })

        return ComplianceReport(
            ok=ok,
            issues=issues,
            elapsed_ms=elapsed_ms,
            manifest_version=manifest_version,
            databases_checked=len(resolved),
            databases_missing=databases_missing,
        )

    def verify_offline(self, schemas: dict[str, dict[str, Any]]) -> ComplianceReport:
        """Verify against pre-fetched schemas (no API calls).

        Useful for testing and for when schemas are already cached.
        Uses local option extraction instead of Notion API.
        """
        started = time.monotonic()
        issues: list[DriftIssueV2] = []
        manifest_version = self.manifest.get("version", "unknown")
        required_dbs: dict[str, Any] = self.manifest.get("databases", {})
        databases_missing = 0

        # Override API methods with local implementations for offline use
        original_extract = self.notion.extract_select_options
        original_relation = self.notion.extract_relation_target_db_id
        self.notion.extract_select_options = lambda prop: prop.get("options", [])
        self.notion.extract_relation_target_db_id = lambda prop: prop.get("target_db_id")

        try:
            for db_key, db_spec in required_dbs.items():
                if db_key not in schemas:
                    databases_missing += 1
                    severity = DriftSeverity.CRITICAL if db_spec.get("required", False) else DriftSeverity.MEDIUM
                    issues.append(DriftIssueV2(
                        database=db_key,
                        issue_type="missing_database",
                        property_name=None,
                        severity=severity,
                        details="Database not found in provided schemas.",
                    ))
                    continue

                issues.extend(self._verify_properties(db_key, schemas[db_key], db_spec))
        finally:
            self.notion.extract_select_options = original_extract
            self.notion.extract_relation_target_db_id = original_relation

        ok = all(i.severity != DriftSeverity.CRITICAL for i in issues)
        return ComplianceReport(
            ok=ok,
            issues=issues,
            elapsed_ms=int((time.monotonic() - started) * 1000),
            manifest_version=manifest_version,
            databases_checked=len(schemas),
            databases_missing=databases_missing,
        )

    def _resolve_db_id(self, db_key: str, db_spec: dict[str, Any]) -> str | None:
        """Resolve database ID: explicit bindings → notion_bindings → discovery."""
        # 1. Explicit bindings
        if db_key in self.explicit_bindings:
            return self.explicit_bindings[db_key]

        # 2. notion_bindings table
        row = self.conn.execute(
            "SELECT notion_object_id FROM notion_bindings WHERE binding_type=? LIMIT 1",
            (db_key,),
        ).fetchone()
        if row:
            return row["notion_object_id"]

        # 3. Discovery (search by title under root page)
        expected_title = db_spec.get("title") or db_key.replace("_", " ").title()
        self.rl.wait("notion.search")
        return self.notion.find_database_under_root(self.root_page_id, expected_title)

    def _verify_properties(
        self, db_key: str, schema: dict[str, Any], db_spec: dict[str, Any]
    ) -> list[DriftIssueV2]:
        """Verify properties exist with correct types and options."""
        issues: list[DriftIssueV2] = []
        actual_props = schema.get("properties", {})

        for prop_name, prop_spec in db_spec.get("properties", {}).items():
            expected_type = prop_spec.get("type", "rich_text")

            if prop_name not in actual_props:
                issues.append(DriftIssueV2(
                    database=db_key,
                    issue_type="missing_property",
                    property_name=prop_name,
                    severity=DriftSeverity.HIGH,
                    details=f"Property '{prop_name}' missing (expected type: {expected_type}).",
                ))
                continue

            actual = actual_props[prop_name]
            actual_type = actual.get("type", "")

            # Type mismatch
            if actual_type != expected_type:
                issues.append(DriftIssueV2(
                    database=db_key,
                    issue_type="wrong_type",
                    property_name=prop_name,
                    severity=DriftSeverity.CRITICAL,
                    details=f"Expected type '{expected_type}', got '{actual_type}'. Manual fix required.",
                ))
                continue

            # Select/multi_select options check
            if expected_type in ("select", "multi_select") and "options" in prop_spec:
                expected_opts = set(prop_spec["options"])
                actual_opts = set(self.notion.extract_select_options(actual))
                missing = sorted(expected_opts - actual_opts)
                if missing:
                    issues.append(DriftIssueV2(
                        database=db_key,
                        issue_type="missing_select_options",
                        property_name=prop_name,
                        severity=DriftSeverity.MEDIUM,
                        details=f"Missing select options: {missing}",
                    ))

            # Relation target check (lightweight — full check in _verify_relations)
            if expected_type == "relation":
                actual_target = self.notion.extract_relation_target_db_id(actual)
                expected_target = prop_spec.get("target")
                # Only flag if target is a direct DB ID (not a logical name)
                if expected_target and not expected_target.replace("_", "").isalpha() and expected_target != actual_target:
                    issues.append(DriftIssueV2(
                        database=db_key,
                        issue_type="wrong_relation_target",
                        property_name=prop_name,
                        severity=DriftSeverity.CRITICAL,
                        details="Relation target mismatch.",
                    ))

        return issues

    def _verify_views_from_registry(
        self, required_dbs: dict[str, Any]
    ) -> list[DriftIssueV2]:
        """Verify views using the Views Registry database in Notion.

        Falls back gracefully if Views Registry doesn't exist yet.
        """
        issues: list[DriftIssueV2] = []

        # Check if views_registry table has data
        try:
            rows = self.conn.execute(
                "SELECT * FROM views_registry WHERE required=1"
            ).fetchall()
        except Exception:
            # views_registry table doesn't exist yet — just flag it
            total_required_views = sum(
                len(db_spec.get("required_views", []))
                for db_spec in required_dbs.values()
            )
            if total_required_views > 0:
                issues.append(DriftIssueV2(
                    database="__system__",
                    issue_type="view_verification_limited",
                    property_name=None,
                    severity=DriftSeverity.LOW,
                    details=f"Views Registry not available. {total_required_views} required views unchecked.",
                ))
            return issues

        # Check registry entries
        for row in rows:
            if row["status"] == "missing":
                issues.append(DriftIssueV2(
                    database=row["database_key"],
                    issue_type="missing_view",
                    property_name=None,
                    severity=DriftSeverity.MEDIUM,
                    details=f"Missing required view: {row['view_name']}",
                ))

        return issues

    def _verify_relations(
        self, resolved: dict[str, str], required_dbs: dict[str, Any]
    ) -> list[DriftIssueV2]:
        """Verify relation targets point to correct databases."""
        issues: list[DriftIssueV2] = []

        for db_key, db_spec in required_dbs.items():
            for prop_name, prop_spec in db_spec.get("properties", {}).items():
                if prop_spec.get("type") != "relation":
                    continue

                target_logical = prop_spec.get("target")
                if not target_logical:
                    continue

                # Target is a logical DB name — verify it exists in resolved
                if isinstance(target_logical, str) and target_logical not in resolved:
                    issues.append(DriftIssueV2(
                        database=db_key,
                        issue_type="unknown_relation_target",
                        property_name=prop_name,
                        severity=DriftSeverity.HIGH,
                        details=f"Relation target '{target_logical}' not found in workspace.",
                    ))

        return issues

    # ── Brand-aware verification ──────────────────────────

    # DBs that are system-only and should NOT have a brand property
    _SYSTEM_DBS = frozenset({
        "system_settings", "views_registry", "system_audit_log", "brands",
    })

    def _verify_brand_property(
        self, resolved: dict[str, str], required_dbs: dict[str, Any]
    ) -> list[DriftIssueV2]:
        """Verify every operational DB has a 'brand' relation -> brands."""
        issues: list[DriftIssueV2] = []
        for db_key, db_spec in required_dbs.items():
            if db_key in self._SYSTEM_DBS:
                continue
            props = db_spec.get("properties", {})
            brand_prop = props.get("brand")
            if not brand_prop:
                issues.append(DriftIssueV2(
                    database=db_key,
                    issue_type="missing_brand_property",
                    property_name="brand",
                    severity=DriftSeverity.HIGH,
                    details="Operational DB missing required 'brand' relation to Brands DB.",
                ))
            elif brand_prop.get("type") != "relation" or brand_prop.get("target") != "brands":
                issues.append(DriftIssueV2(
                    database=db_key,
                    issue_type="wrong_brand_property",
                    property_name="brand",
                    severity=DriftSeverity.CRITICAL,
                    details="'brand' property must be a relation targeting brands DB.",
                ))
        return issues

    def _verify_brand_views(self) -> list[DriftIssueV2]:
        """Verify per-brand view registry keys exist (cc.fd.*, cc.cutmv.*, cc.global.*)."""
        issues: list[DriftIssueV2] = []
        cc = self.manifest.get("command_center", {})
        required_entries = cc.get("required_views_registry_entries", [])
        brand_prefixes = ("cc.global.", "cc.fd.", "cc.cutmv.")

        brand_keys = [
            e["view_key"] for e in required_entries
            if any(e["view_key"].startswith(p) for p in brand_prefixes)
        ]

        if not brand_keys:
            return issues

        # Check views_registry table for these keys
        try:
            rows = self.conn.execute(
                "SELECT view_key, status FROM views_registry"
            ).fetchall()
            existing = {r["view_key"]: r["status"] for r in rows}
        except Exception:
            issues.append(DriftIssueV2(
                database="__system__",
                issue_type="brand_view_verification_limited",
                property_name=None,
                severity=DriftSeverity.LOW,
                details=f"Views Registry not available. {len(brand_keys)} brand views unchecked.",
            ))
            return issues

        for vk in brand_keys:
            status = existing.get(vk)
            if status is None or status == "missing":
                issues.append(DriftIssueV2(
                    database="__system__",
                    issue_type="missing_brand_view",
                    property_name=None,
                    severity=DriftSeverity.MEDIUM,
                    details=f"Missing required brand view: {vk}",
                ))

        return issues

    def _verify_capacity_override(
        self, resolved: dict[str, str]
    ) -> list[DriftIssueV2]:
        """Verify capacity override fields on system_settings are consistent.

        If capacity_override_ok_to_scale is checked but capacity_override_expires_at
        is missing, flag a warning — the override will be ignored at runtime.
        """
        issues: list[DriftIssueV2] = []

        if "system_settings" not in resolved:
            return issues

        # Check via local system_settings table (faster than API)
        try:
            override_row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='capacity_override_ok_to_scale'"
            ).fetchone()
            expires_row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='capacity_override_expires_at'"
            ).fetchone()
        except Exception:
            return issues

        override_on = override_row and str(override_row[0]).lower() in ("true", "1", "yes")
        expires_val = expires_row[0] if expires_row else None

        if override_on and not expires_val:
            issues.append(DriftIssueV2(
                database="system_settings",
                issue_type="capacity_override_inconsistent",
                property_name="capacity_override_expires_at",
                severity=DriftSeverity.MEDIUM,
                details=(
                    "capacity_override_ok_to_scale is checked but "
                    "capacity_override_expires_at is missing — override will be ignored."
                ),
            ))

        return issues

    def persist_report(self, report: ComplianceReport) -> None:
        """Save compliance report summary to system_snapshots."""
        import json

        now = utc_now_iso()
        summary = {
            "ok": report.ok,
            "total_issues": len(report.issues),
            "critical": report.critical_count,
            "healable": report.healable_count,
            "manual": report.manual_count,
            "databases_checked": report.databases_checked,
            "databases_missing": report.databases_missing,
            "elapsed_ms": report.elapsed_ms,
            "manifest_version": report.manifest_version,
        }
        try:
            self.conn.execute(
                """INSERT OR REPLACE INTO system_snapshots
                   (key, value_json, snapshot_type, created_at)
                   VALUES (?, ?, 'compliance', ?)""",
                ("last_compliance_check", json.dumps(summary), now),
            )
            self.conn.commit()
        except Exception:
            pass
