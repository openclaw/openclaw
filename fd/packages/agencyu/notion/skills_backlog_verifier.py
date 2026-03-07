"""Skills Backlog DB compliance verifier.

Returns a structured result that plugs into the existing compliance model pattern.
Read-only: never writes to Notion.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.skills_backlog_schema import (
    notion_prop_type_from_db_property,
    required_prop_map,
)
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.skills_backlog_verifier")


@dataclass
class MissingProp:
    property_key: str
    expected_type: str


@dataclass
class MismatchedProp:
    property_key: str
    expected_type: str
    actual_type: str


@dataclass
class MissingOption:
    property_key: str
    option_name: str


@dataclass
class SkillsBacklogCompliance:
    db_id: str
    db_exists: bool = False
    compliant: bool = False

    missing_props: list[MissingProp] = field(default_factory=list)
    mismatched_props: list[MismatchedProp] = field(default_factory=list)
    missing_options: list[MissingOption] = field(default_factory=list)

    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "db_id": self.db_id,
            "db_exists": self.db_exists,
            "compliant": self.compliant,
            "missing_props": [p.__dict__ for p in self.missing_props],
            "mismatched_props": [p.__dict__ for p in self.mismatched_props],
            "missing_options": [p.__dict__ for p in self.missing_options],
            "warnings": self.warnings,
        }


def verify_skills_backlog_db(
    api: NotionAPI, db_id: str
) -> SkillsBacklogCompliance:
    """Verify the Skills Backlog DB exists with correct properties and options.

    Read-only: never writes to Notion.
    """
    res = SkillsBacklogCompliance(db_id=db_id)

    try:
        db = api.get_database(db_id)
    except Exception as exc:
        log.warning("skills_backlog_db_fetch_failed", extra={"db_id": db_id, "error": str(exc)})
        res.db_exists = False
        res.compliant = False
        return res

    if not db:
        res.db_exists = False
        res.compliant = False
        return res

    res.db_exists = True
    props: dict[str, Any] = db.get("properties", {}) or {}

    required = required_prop_map()

    for key, spec in required.items():
        if key not in props:
            res.missing_props.append(
                MissingProp(property_key=key, expected_type=spec.notion_type)
            )
            continue

        actual_type = notion_prop_type_from_db_property(props[key])
        if actual_type != spec.notion_type:
            res.mismatched_props.append(
                MismatchedProp(
                    property_key=key,
                    expected_type=spec.notion_type,
                    actual_type=str(actual_type),
                )
            )
            continue

        # Check required options for selects
        if spec.select_options and spec.notion_type in ("select", "multi_select"):
            existing = _extract_select_option_names(props[key])
            for opt in spec.select_options.required:
                if opt not in existing:
                    res.missing_options.append(
                        MissingOption(property_key=key, option_name=opt)
                    )

    res.compliant = (
        res.db_exists
        and not res.missing_props
        and not res.mismatched_props
        and not res.missing_options
    )

    log.info("skills_backlog_verified", extra={
        "db_id": db_id,
        "compliant": res.compliant,
        "missing_props": len(res.missing_props),
        "mismatched_props": len(res.mismatched_props),
        "missing_options": len(res.missing_options),
    })

    return res


def _extract_select_option_names(prop: dict[str, Any]) -> list[str]:
    """Extract option names from a select or multi_select property."""
    t = prop.get("type")
    options: list[str] = prop.get("options", [])
    if isinstance(options, list) and options and isinstance(options[0], str):
        # Already normalized by get_database()
        return options
    # Raw Notion API format
    if t == "select":
        opts = (prop.get("select") or {}).get("options") or []
    elif t == "multi_select":
        opts = (prop.get("multi_select") or {}).get("options") or []
    else:
        return []
    return [o.get("name") for o in opts if o.get("name")]
