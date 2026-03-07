from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from packages.agencyu.notion_os.manifest import TemplateManifest
from packages.common.logging import get_logger

log = get_logger("agencyu.notion_os.compliance")


@dataclass
class ComplianceIssue:
    severity: str  # error/warn
    scope: str     # workspace/database/property/view/template
    message: str
    details: dict[str, Any] | None = None


@dataclass
class ComplianceReport:
    passed: bool
    issues: list[ComplianceIssue] = field(default_factory=list)


class NotionComplianceValidator:
    """Validates an actual Notion workspace against a TemplateManifest.

    The Notion client adapter should provide:
      - root page title + children
      - database schemas (properties)
      - database views metadata (where accessible)
    """

    def __init__(self, notion_client: Any) -> None:
        self.notion = notion_client

    def validate(self, root_page_id: str, manifest: TemplateManifest) -> ComplianceReport:
        issues: list[ComplianceIssue] = []

        # 1) Root page title + required children
        root = self.notion.get_page(root_page_id)
        if root.get("title") != manifest.root_page_title:
            issues.append(ComplianceIssue(
                severity="error",
                scope="workspace",
                message="Root page title mismatch",
                details={"expected": manifest.root_page_title, "actual": root.get("title")},
            ))

        children = self.notion.list_child_pages(root_page_id)
        child_titles = {c["title"] for c in children}
        for required in manifest.required_child_pages:
            if required not in child_titles:
                issues.append(ComplianceIssue(
                    severity="error",
                    scope="workspace",
                    message="Missing required child page",
                    details={"missing": required},
                ))

        # 2) Database discovery + schema validation
        discovered = self.notion.discover_databases_under_root(root_page_id)
        by_name = {d["name"]: d for d in discovered}

        for db_spec in manifest.databases:
            if db_spec.name not in by_name:
                issues.append(ComplianceIssue(
                    severity="error",
                    scope="database",
                    message="Missing required database",
                    details={"database": db_spec.name, "key": db_spec.key},
                ))
                continue

            db = by_name[db_spec.name]
            schema = db.get("schema", {})
            for prop in db_spec.properties:
                if prop.name not in schema:
                    issues.append(ComplianceIssue(
                        severity="error",
                        scope="property",
                        message="Missing required property",
                        details={"database": db_spec.name, "property": prop.name},
                    ))
                    continue

                actual_type = schema[prop.name].get("type")
                if actual_type != prop.type:
                    issues.append(ComplianceIssue(
                        severity="error",
                        scope="property",
                        message="Property type mismatch",
                        details={
                            "database": db_spec.name,
                            "property": prop.name,
                            "expected_type": prop.type,
                            "actual_type": actual_type,
                        },
                    ))

                if prop.options:
                    actual_opts = schema[prop.name].get("options", [])
                    missing_opts = [o for o in prop.options if o not in actual_opts]
                    if missing_opts:
                        issues.append(ComplianceIssue(
                            severity="error",
                            scope="property",
                            message="Missing select/status options",
                            details={
                                "database": db_spec.name,
                                "property": prop.name,
                                "missing": missing_opts,
                            },
                        ))

            # 3) Views validation (best-effort)
            if db_spec.required_views:
                views = self.notion.list_database_views(db["id"])
                view_names = {v["name"] for v in views}
                for rv in db_spec.required_views:
                    if rv.name not in view_names:
                        issues.append(ComplianceIssue(
                            severity="warn",
                            scope="view",
                            message="Missing recommended view",
                            details={"database": db_spec.name, "view": rv.name},
                        ))

        passed = not any(i.severity == "error" for i in issues)
        log.info("compliance_check_done", extra={"passed": passed, "issue_count": len(issues)})
        return ComplianceReport(passed=passed, issues=issues)
