"""Strong output schema for Notion compliance verification.

Used by both the SQLite-based CommandCenterComplianceVerifier and the
live-API NotionComplianceVerifier. Provides exact missing-keys lists
for operators and automated repair.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MissingProperty:
    """A required DB property that doesn't exist or has wrong type."""

    db_key: str
    property_key: str
    expected_type: str
    actual_type: str = ""  # Empty = missing entirely


@dataclass
class MissingViewKey:
    """A required view_key not found in the Views Registry DB."""

    view_key: str
    db_key: str


@dataclass
class ComplianceResult:
    """Full compliance result with exact missing-keys lists.

    Used by /admin/notion/verify and /admin/notion/verify_command_center.
    """

    compliant: bool = True
    template_version: str = ""
    os_version: str = ""

    missing_pages: list[str] = field(default_factory=list)
    missing_db_keys: list[str] = field(default_factory=list)
    missing_db_properties: list[MissingProperty] = field(default_factory=list)
    missing_view_keys: list[MissingViewKey] = field(default_factory=list)
    missing_widgets: list[str] = field(default_factory=list)
    missing_portal_sections: list[str] = field(default_factory=list)

    write_lock: bool | None = None
    safe_mode: bool | None = None
    last_verified_at: str | None = None

    warnings: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "compliant": self.compliant,
            "template_version": self.template_version,
            "os_version": self.os_version,
            "missing_pages": self.missing_pages,
            "missing_db_keys": self.missing_db_keys,
            "missing_db_properties": [
                {
                    "db_key": p.db_key,
                    "property_key": p.property_key,
                    "expected_type": p.expected_type,
                    "actual_type": p.actual_type,
                }
                for p in self.missing_db_properties
            ],
            "missing_view_keys": [
                {"view_key": v.view_key, "db_key": v.db_key}
                for v in self.missing_view_keys
            ],
            "missing_widgets": self.missing_widgets,
            "missing_portal_sections": self.missing_portal_sections,
            "write_lock": self.write_lock,
            "safe_mode": self.safe_mode,
            "last_verified_at": self.last_verified_at,
            "warnings": self.warnings,
            "details": self.details,
        }

    @property
    def summary(self) -> str:
        if self.compliant:
            return "Notion workspace is compliant"
        parts = []
        if self.missing_pages:
            parts.append(f"{len(self.missing_pages)} missing pages")
        if self.missing_db_keys:
            parts.append(f"{len(self.missing_db_keys)} missing databases")
        if self.missing_db_properties:
            parts.append(f"{len(self.missing_db_properties)} missing properties")
        if self.missing_view_keys:
            parts.append(f"{len(self.missing_view_keys)} missing view keys")
        if self.missing_widgets:
            parts.append(f"{len(self.missing_widgets)} missing widgets")
        if self.missing_portal_sections:
            parts.append(f"{len(self.missing_portal_sections)} missing portal sections")
        return "NOT compliant: " + ", ".join(parts)

    @property
    def fix_count(self) -> int:
        return (
            len(self.missing_pages)
            + len(self.missing_db_keys)
            + len(self.missing_db_properties)
            + len(self.missing_view_keys)
            + len(self.missing_widgets)
            + len(self.missing_portal_sections)
        )
