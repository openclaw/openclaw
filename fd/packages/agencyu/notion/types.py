from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class DriftSeverity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class DriftIssueV2:
    """Extended drift issue with severity levels for compliance verifier.

    Compared to the base DriftIssue in manifest_validator.py, this adds:
    - severity: graduated severity levels
    - healable: derived from issue_type + severity
    """

    database: str
    issue_type: str
    property_name: str | None
    severity: DriftSeverity
    details: str

    @property
    def healable(self) -> bool:
        return self.issue_type in ("missing_property", "missing_select_options", "missing_relation")

    @property
    def is_critical(self) -> bool:
        return self.severity == DriftSeverity.CRITICAL


@dataclass
class ComplianceReport:
    """Full compliance report from the compliance verifier."""

    ok: bool
    issues: list[DriftIssueV2] = field(default_factory=list)
    elapsed_ms: int = 0
    manifest_version: str = ""
    databases_checked: int = 0
    databases_missing: int = 0

    @property
    def healable_count(self) -> int:
        return sum(1 for i in self.issues if i.healable)

    @property
    def manual_count(self) -> int:
        return sum(1 for i in self.issues if not i.healable)

    @property
    def critical_count(self) -> int:
        return sum(1 for i in self.issues if i.is_critical)
