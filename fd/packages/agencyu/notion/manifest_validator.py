from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from packages.common.logging import get_logger

log = get_logger("agencyu.notion.manifest_validator")


@dataclass
class DriftIssue:
    database: str
    issue_type: str  # missing_database/missing_property/wrong_type/missing_option/missing_view
    property_name: str | None
    details: str
    healable: bool = False  # Can be auto-healed?


@dataclass
class ComplianceResult:
    compliant: bool
    issues: list[DriftIssue] = field(default_factory=list)
    healable_count: int = 0
    manual_count: int = 0
    manifest_version: str = ""


def load_yaml_manifest(manifest_path: str | Path | None = None) -> dict[str, Any]:
    """Load the YAML template manifest."""
    if manifest_path is None:
        manifest_path = Path(__file__).parent / "template_manifest.yaml"
    return yaml.safe_load(Path(manifest_path).read_text())


class NotionManifestValidator:
    """Validates Notion workspace against the YAML template manifest.

    Works with either:
    - A live Notion client (fetches actual schema via API)
    - A pre-fetched schema dict (for testing)
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_client: Any = None,
        manifest_path: str | Path | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_client
        self.manifest = load_yaml_manifest(manifest_path)

    def validate(self, schemas: dict[str, dict[str, Any]] | None = None) -> ComplianceResult:
        """Validate all databases against the manifest.

        Args:
            schemas: Optional pre-fetched schemas keyed by db_key.
                     If None, resolves from notion_bindings + Notion API.

        Returns:
            ComplianceResult with issues list.
        """
        issues: list[DriftIssue] = []
        manifest_version = self.manifest.get("version", "unknown")

        for db_key, db_spec in self.manifest.get("databases", {}).items():
            # Resolve database ID from bindings
            db_id = self._resolve_db_id(db_key)

            if not db_id and schemas and db_key not in schemas:
                issues.append(DriftIssue(
                    database=db_key,
                    issue_type="missing_database",
                    property_name=None,
                    details="Database not bound in notion_bindings",
                    healable=False,
                ))
                continue

            # Get schema (from pre-fetched or API)
            schema = None
            if schemas and db_key in schemas:
                schema = schemas[db_key]
            elif self.notion and db_id:
                schema = self._fetch_schema(db_id)

            if schema is None:
                if db_spec.get("required", False):
                    issues.append(DriftIssue(
                        database=db_key,
                        issue_type="missing_database",
                        property_name=None,
                        details="Cannot fetch schema — database not accessible",
                        healable=False,
                    ))
                continue

            issues.extend(self._compare_schema(db_key, schema, db_spec))
            issues.extend(self._check_views(db_key, schema, db_spec))

        healable_count = sum(1 for i in issues if i.healable)
        manual_count = sum(1 for i in issues if not i.healable)
        compliant = len(issues) == 0

        log.info("manifest_validation_complete", extra={
            "compliant": compliant,
            "total_issues": len(issues),
            "healable": healable_count,
            "manual": manual_count,
        })

        return ComplianceResult(
            compliant=compliant,
            issues=issues,
            healable_count=healable_count,
            manual_count=manual_count,
            manifest_version=manifest_version,
        )

    def _compare_schema(
        self, db_key: str, schema: dict[str, Any], spec: dict[str, Any]
    ) -> list[DriftIssue]:
        issues: list[DriftIssue] = []
        schema_props = schema.get("properties", {})

        for prop_name, prop_spec in spec.get("properties", {}).items():
            if prop_name not in schema_props:
                issues.append(DriftIssue(
                    database=db_key,
                    issue_type="missing_property",
                    property_name=prop_name,
                    details=f"Property '{prop_name}' missing (type: {prop_spec['type']})",
                    healable=True,
                ))
                continue

            actual = schema_props[prop_name]
            actual_type = actual.get("type", "")

            if actual_type != prop_spec["type"]:
                issues.append(DriftIssue(
                    database=db_key,
                    issue_type="wrong_type",
                    property_name=prop_name,
                    details=f"Expected type '{prop_spec['type']}', got '{actual_type}'",
                    healable=False,  # Type changes require manual intervention
                ))
                continue

            # Check select options
            if prop_spec["type"] == "select" and "options" in prop_spec:
                actual_options = {o for o in actual.get("options", [])}
                for required_opt in prop_spec["options"]:
                    if required_opt not in actual_options:
                        issues.append(DriftIssue(
                            database=db_key,
                            issue_type="missing_option",
                            property_name=prop_name,
                            details=f"Missing select option '{required_opt}'",
                            healable=True,
                        ))

        return issues

    def _check_views(
        self, db_key: str, schema: dict[str, Any], spec: dict[str, Any]
    ) -> list[DriftIssue]:
        issues: list[DriftIssue] = []
        existing_views = {v for v in schema.get("views", [])}

        for required_view in spec.get("required_views", []):
            if required_view not in existing_views:
                issues.append(DriftIssue(
                    database=db_key,
                    issue_type="missing_view",
                    property_name=None,
                    details=f"Missing required view '{required_view}'",
                    healable=False,  # Views cannot be created via Notion API
                ))

        return issues

    def _resolve_db_id(self, db_key: str) -> str | None:
        """Resolve a database key to its Notion database ID via notion_bindings."""
        row = self.conn.execute(
            "SELECT notion_object_id FROM notion_bindings WHERE binding_type=? LIMIT 1",
            (db_key,),
        ).fetchone()
        return row["notion_object_id"] if row else None

    def _fetch_schema(self, db_id: str) -> dict[str, Any] | None:
        """Fetch database schema from Notion API."""
        if not self.notion:
            return None
        try:
            resp = self.notion.query_db(db_id)
            # Parse schema from response — structure depends on API version
            return resp
        except Exception as exc:
            log.warning("schema_fetch_failed", extra={"db_id": db_id, "error": str(exc)})
            return None
