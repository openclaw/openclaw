"""Typed wrapper for the YAML template manifest.

Provides a Manifest dataclass with typed accessors for all manifest sections.
Includes basic structural validation on load — runtime verifiers provide
detailed compliance checks.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from packages.common.logging import get_logger

log = get_logger("agencyu.notion.template_manifest")


@dataclass(frozen=True)
class Manifest:
    """Typed accessor over the raw YAML manifest dict."""

    raw: dict[str, Any] = field(repr=False)

    @property
    def version(self) -> str:
        return str(self.raw.get("version", "unknown"))

    @property
    def template_version(self) -> str:
        return str(self.raw.get("template_version", self.version))

    @property
    def os_version(self) -> str:
        return str(self.raw.get("os_version", "unknown"))

    @property
    def owner(self) -> str:
        return str(self.raw.get("owner", "openclaw"))

    @property
    def governance(self) -> dict[str, Any]:
        return dict(self.raw.get("governance", {}))

    @property
    def required_root_pages(self) -> list[dict[str, Any]]:
        return list(self.raw.get("required_root_pages", []))

    @property
    def databases(self) -> dict[str, dict[str, Any]]:
        return dict(self.raw.get("databases", {}))

    @property
    def command_center(self) -> dict[str, Any]:
        return dict(self.raw.get("command_center", {}))

    @property
    def portal_templates(self) -> dict[str, Any]:
        return dict(self.raw.get("portal_templates", {}))

    @property
    def system_settings_page(self) -> dict[str, Any]:
        return dict(self.raw.get("system_settings_page", {}))

    @property
    def ux_rules(self) -> dict[str, Any]:
        return dict(self.raw.get("ux_rules", {}))

    @property
    def integrations_mode(self) -> str:
        gov = self.governance
        return str(gov.get("integrations_mode", "clawdcursor_preferred"))

    def get_db(self, db_key: str) -> dict[str, Any] | None:
        return self.databases.get(db_key)

    def get_required_db_keys(self) -> list[str]:
        return [k for k, v in self.databases.items() if v.get("required", False)]

    def get_required_widget_keys(self) -> list[str]:
        cc = self.command_center
        return [w["widget_key"] for w in cc.get("required_widgets", []) if w.get("widget_key")]

    def get_required_view_entries(self) -> list[dict[str, Any]]:
        cc = self.command_center
        return list(cc.get("required_views_registry_entries", []))

    def get_required_portal_section_keys(self) -> list[str]:
        pt = self.portal_templates
        return [s["section_key"] for s in pt.get("required_sections", []) if s.get("section_key")]

    def get_required_page_keys(self) -> list[str]:
        return [p["page_key"] for p in self.required_root_pages if p.get("page_key")]


def load_manifest(path: str | Path | None = None) -> Manifest:
    """Load and validate the YAML template manifest.

    Args:
        path: Path to manifest file. Defaults to template_manifest.yaml
              adjacent to this module.

    Returns:
        Typed Manifest wrapper.

    Raises:
        ValueError: If required top-level keys are missing.
    """
    if path is None:
        path = Path(__file__).parent / "template_manifest.yaml"
    raw = yaml.safe_load(Path(path).read_text())
    _basic_validate(raw)
    return Manifest(raw=raw)


def _basic_validate(raw: dict[str, Any]) -> None:
    """Fast structural checks. Runtime verifier provides detailed errors."""
    if not isinstance(raw, dict):
        raise ValueError("template_manifest.yaml must be a YAML mapping")

    required_keys = ["version", "databases"]
    for k in required_keys:
        if k not in raw:
            raise ValueError(f"template_manifest.yaml missing top-level key: {k}")

    if not isinstance(raw["databases"], dict):
        raise ValueError("template_manifest.yaml: 'databases' must be a mapping")

    log.debug("manifest_loaded", extra={
        "version": raw.get("version"),
        "db_count": len(raw.get("databases", {})),
    })
