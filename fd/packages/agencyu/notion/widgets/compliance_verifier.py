"""Command Center Compliance Verifier — checks full AgencyOS compliance.

Returns a structured report:
  compliant: true/false
  missing_db_keys: []
  missing_pages: []
  missing_db_properties: [{db_key, property_key, expected_type}]
  missing_view_keys: []
  missing_widgets: []
  missing_portal_sections: []
  write_lock: true/false
  warnings: []
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from packages.agencyu.notion.manifest_validator import load_yaml_manifest
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.widgets.compliance_verifier")


@dataclass
class MissingProperty:
    db_key: str
    property_key: str
    expected_type: str


@dataclass
class ComplianceReport:
    """Full Command Center compliance report."""

    compliant: bool = True
    missing_db_keys: list[str] = field(default_factory=list)
    missing_pages: list[str] = field(default_factory=list)
    missing_db_properties: list[MissingProperty] = field(default_factory=list)
    missing_view_keys: list[str] = field(default_factory=list)
    missing_widgets: list[str] = field(default_factory=list)
    missing_portal_sections: list[str] = field(default_factory=list)
    missing_blocks: list[str] = field(default_factory=list)
    brand_switcher_issues: list[str] = field(default_factory=list)
    write_lock: bool = False
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "compliant": self.compliant,
            "missing_db_keys": self.missing_db_keys,
            "missing_pages": self.missing_pages,
            "missing_db_properties": [
                {"db_key": p.db_key, "property_key": p.property_key, "expected_type": p.expected_type}
                for p in self.missing_db_properties
            ],
            "missing_view_keys": self.missing_view_keys,
            "missing_widgets": self.missing_widgets,
            "missing_portal_sections": self.missing_portal_sections,
            "missing_blocks": self.missing_blocks,
            "brand_switcher_issues": self.brand_switcher_issues,
            "write_lock": self.write_lock,
            "warnings": self.warnings,
        }

    @property
    def summary(self) -> str:
        if self.compliant:
            return "Command Center is compliant"
        parts = []
        if self.missing_db_keys:
            parts.append(f"missing DB keys {self.missing_db_keys}")
        if self.missing_view_keys:
            parts.append(f"missing view_keys {self.missing_view_keys}")
        if self.missing_db_properties:
            keys = [f"{p.db_key}.{p.property_key}" for p in self.missing_db_properties]
            parts.append(f"missing properties {keys}")
        if self.missing_widgets:
            parts.append(f"missing widgets {self.missing_widgets}")
        if self.missing_portal_sections:
            parts.append(f"missing portal sections {self.missing_portal_sections}")
        if self.missing_pages:
            parts.append(f"missing pages {self.missing_pages}")
        if self.missing_blocks:
            parts.append(f"missing blocks {self.missing_blocks}")
        if self.brand_switcher_issues:
            parts.append(f"brand switcher issues {self.brand_switcher_issues}")
        return "Command Center is NOT compliant: " + ", ".join(parts)


class CommandCenterComplianceVerifier:
    """Verifies full AgencyOS + Command Center compliance against manifest.

    Checks:
    1. All required databases are bound (notion_bindings table)
    2. All required DB properties exist (via cached schema or live API)
    3. All required view_keys exist in Views Registry DB
    4. All required widgets have marker blocks on Command Center page
    5. All required portal sections are registered
    6. Required root pages exist
    7. Write lock and safe mode status
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        manifest_path: str | Path | None = None,
    ) -> None:
        self.conn = conn
        self.manifest = load_yaml_manifest(manifest_path)

    def verify(
        self,
        *,
        schemas: dict[str, dict[str, Any]] | None = None,
        registered_widgets: set[str] | None = None,
        registered_portal_sections: set[str] | None = None,
    ) -> ComplianceReport:
        """Run full compliance verification.

        Args:
            schemas: Optional pre-fetched DB schemas keyed by db_key.
            registered_widgets: Set of widget_keys that have marker blocks.
            registered_portal_sections: Set of section_keys that exist.
        """
        report = ComplianceReport()

        # Check write_lock
        report.write_lock = self._check_write_lock()
        if report.write_lock:
            report.warnings.append("write_lock is enabled")

        # Check safe_mode
        if self._check_safe_mode():
            report.warnings.append("safe_mode is enabled")

        # 1. Check required databases
        self._check_databases(report, schemas)

        # 2. Check required view_keys
        self._check_view_keys(report)

        # 3. Check required widgets
        self._check_widgets(report, registered_widgets)

        # 4. Check required portal sections
        self._check_portal_sections(report, registered_portal_sections)

        # 5. Check required root pages
        self._check_root_pages(report)

        # 6. Check required blocks (brand switcher etc.)
        self._check_required_blocks(report)

        # 7. Check brand switcher structural integrity
        self._check_brand_switcher(report)

        # Determine overall compliance
        report.compliant = (
            not report.missing_db_keys
            and not report.missing_db_properties
            and not report.missing_view_keys
            and not report.missing_widgets
            and not report.missing_portal_sections
            and not report.missing_pages
            and not report.missing_blocks
        )

        log.info("compliance_check_complete", extra={
            "is_compliant": report.compliant,
            "missing_dbs": len(report.missing_db_keys),
            "missing_props": len(report.missing_db_properties),
            "missing_views": len(report.missing_view_keys),
            "missing_widgets": len(report.missing_widgets),
        })

        return report

    def _check_write_lock(self) -> bool:
        try:
            row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='write_lock'"
            ).fetchone()
            if not row:
                return True  # default: locked
            return row[0] in ("true", "1", "True")
        except Exception:
            return True

    def _check_safe_mode(self) -> bool:
        try:
            row = self.conn.execute(
                "SELECT value FROM system_settings WHERE key='safe_mode'"
            ).fetchone()
            if not row:
                return True
            return row[0] in ("true", "1", "True")
        except Exception:
            return True

    def _check_databases(
        self, report: ComplianceReport, schemas: dict[str, dict[str, Any]] | None
    ) -> None:
        """Check that all required databases exist and have required properties."""
        databases = self.manifest.get("databases", {})

        for db_key, db_spec in databases.items():
            if not db_spec.get("required", False):
                continue

            # Check binding exists
            bound = self._has_binding(db_key)
            if not bound:
                report.missing_db_keys.append(db_key)
                continue

            # Check properties if schemas provided
            if schemas and db_key in schemas:
                schema_props = schemas[db_key].get("properties", {})
                for prop_name, prop_spec in db_spec.get("properties", {}).items():
                    if prop_name not in schema_props:
                        report.missing_db_properties.append(
                            MissingProperty(
                                db_key=db_key,
                                property_key=prop_name,
                                expected_type=prop_spec.get("type", "unknown"),
                            )
                        )

    def _check_view_keys(self, report: ComplianceReport) -> None:
        """Check that all required view_keys exist in views_registry."""
        cc = self.manifest.get("command_center", {})
        required_entries = cc.get("required_views_registry_entries", [])

        for entry in required_entries:
            view_key = entry.get("view_key", "")
            if not view_key:
                continue
            if not self._view_key_exists(view_key):
                report.missing_view_keys.append(view_key)

        # Also check per-database required views
        databases = self.manifest.get("databases", {})
        for db_key, db_spec in databases.items():
            for view_name in db_spec.get("required_views", []):
                vk = f"{db_key}.{view_name.lower().replace(' ', '_')}"
                # Only warn, don't fail — per-DB views are tracked separately
                if not self._view_key_exists_loose(db_key, view_name):
                    report.warnings.append(f"view not registered: {vk}")

    def _check_widgets(
        self, report: ComplianceReport, registered_widgets: set[str] | None
    ) -> None:
        """Check that all required widgets are present."""
        cc = self.manifest.get("command_center", {})
        required_widgets = cc.get("required_widgets", [])

        if registered_widgets is None:
            # Cannot verify — skip but warn
            report.warnings.append("widget registration not provided; skipping widget check")
            return

        for w in required_widgets:
            wk = w.get("widget_key", "")
            if wk and wk not in registered_widgets:
                report.missing_widgets.append(wk)

    def _check_portal_sections(
        self, report: ComplianceReport, registered_sections: set[str] | None
    ) -> None:
        """Check that all required portal sections are registered."""
        portal = self.manifest.get("portal_templates", {})
        required_sections = portal.get("required_sections", [])

        if registered_sections is None:
            report.warnings.append("portal sections not provided; skipping portal check")
            return

        for s in required_sections:
            sk = s.get("section_key", "")
            if sk and sk not in registered_sections:
                report.missing_portal_sections.append(sk)

    def _check_root_pages(self, report: ComplianceReport) -> None:
        """Check that required root pages are bound."""
        required_pages = self.manifest.get("required_root_pages", [])
        for page in required_pages:
            pk = page.get("page_key", "")
            if pk and not self._has_binding(pk):
                report.missing_pages.append(pk)

    def _has_binding(self, key: str) -> bool:
        """Check if a binding exists in notion_bindings table."""
        try:
            row = self.conn.execute(
                "SELECT 1 FROM notion_bindings WHERE binding_type=? LIMIT 1",
                (key,),
            ).fetchone()
            return row is not None
        except Exception:
            return False

    def _view_key_exists(self, view_key: str) -> bool:
        """Check if a view_key row exists in views_registry table."""
        try:
            row = self.conn.execute(
                "SELECT 1 FROM views_registry WHERE "
                "id=? OR view_name=? OR "
                "database_key || '.' || REPLACE(LOWER(view_name), ' ', '_') = ? "
                "LIMIT 1",
                (view_key, view_key, view_key),
            ).fetchone()
            return row is not None
        except Exception:
            return False

    def _check_required_blocks(self, report: ComplianceReport) -> None:
        """Check that required Command Center blocks are tracked."""
        cc = self.manifest.get("command_center", {})
        required_blocks = cc.get("required_blocks", [])

        for block_spec in required_blocks:
            block_key = block_spec.get("block_key", "")
            if not block_key:
                continue
            if not self._has_marker_tracked(block_key):
                report.missing_blocks.append(block_key)
            # Check children recursively
            for child in block_spec.get("children", []):
                child_key = child.get("block_key", "")
                if child_key and not self._has_marker_tracked(child_key):
                    report.missing_blocks.append(child_key)

    def _check_brand_switcher(self, report: ComplianceReport) -> None:
        """Check brand switcher structural integrity via BrandSwitcherVerifier."""
        try:
            from packages.agencyu.notion.widgets.brand_switcher_verifier import (
                BrandSwitcherVerifier,
            )

            verifier = BrandSwitcherVerifier(self.conn)
            result = verifier.verify()
            if not result.get("ok"):
                report.brand_switcher_issues = result.get("missing", [])
                report.warnings.append(
                    f"brand_switcher_issues:{len(report.brand_switcher_issues)}"
                )
        except Exception as exc:
            report.warnings.append(f"brand_switcher_check_error:{exc}")

    def _has_marker_tracked(self, block_key: str) -> bool:
        """Check if a block marker is tracked in system state."""
        # Block markers are tracked via system_snapshots when written
        try:
            row = self.conn.execute(
                "SELECT 1 FROM system_snapshots WHERE key=? LIMIT 1",
                (f"marker:{block_key}",),
            ).fetchone()
            return row is not None
        except Exception:
            return False

    def _view_key_exists_loose(self, db_key: str, view_name: str) -> bool:
        """Check if a view exists in views_registry by db_key + view_name."""
        try:
            row = self.conn.execute(
                "SELECT 1 FROM views_registry WHERE database_key=? AND view_name=? LIMIT 1",
                (db_key, view_name),
            ).fetchone()
            return row is not None
        except Exception:
            return False
