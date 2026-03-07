"""Skills Backlog drift healer — creates missing properties and select options.

Schema-lock discipline:
- safe_mode=True (default): simulate only, return planned actions
- write_lock must be False to apply changes
- allow_schema_writes must be True to apply changes
- Does NOT auto-fix mismatched property types (emits warning action)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.skills_backlog_schema import required_prop_map
from packages.agencyu.notion.skills_backlog_verifier import (
    SkillsBacklogCompliance,
    verify_skills_backlog_db,
)
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.skills_backlog_drift_healer")


@dataclass
class DriftHealResult:
    ok: bool
    mode: str  # simulate | apply
    actions_planned: list[dict[str, Any]] = field(default_factory=list)
    actions_applied: list[dict[str, Any]] = field(default_factory=list)
    blocked_reason: str | None = None
    compliance_after: dict[str, Any] | None = None


def heal_skills_backlog_db(
    api: NotionAPI,
    db_id: str,
    *,
    safe_mode: bool = True,
    allow_schema_writes: bool = False,
    write_lock: bool = True,
) -> DriftHealResult:
    """Plan and optionally apply drift healing for the Skills Backlog DB.

    Schema-lock discipline:
    - If write_lock is True -> do not apply changes
    - allow_schema_writes must be True to apply (explicit opt-in)
    - safe_mode simulates without touching Notion
    """
    before = verify_skills_backlog_db(api, db_id)
    planned: list[dict[str, Any]] = []
    applied: list[dict[str, Any]] = []

    # If DB missing, healer won't create DB (separate bootstrap step)
    if not before.db_exists:
        return DriftHealResult(
            ok=False,
            mode="simulate" if safe_mode else "apply",
            actions_planned=[],
            actions_applied=[],
            blocked_reason="skills_backlog_db_missing",
        )

    required = required_prop_map()

    # Plan: create missing properties
    for mp in before.missing_props:
        spec = required.get(mp.property_key)
        if not spec:
            continue
        planned.append({
            "action": "create_property",
            "property_key": spec.key,
            "type": spec.notion_type,
            "required_options": (
                spec.select_options.required if spec.select_options else None
            ),
        })

    # Plan: add missing options (only if property exists and type matches)
    for mo in before.missing_options:
        planned.append({
            "action": "add_select_option",
            "property_key": mo.property_key,
            "option_name": mo.option_name,
        })

    # We do NOT automatically fix mismatched types in v1.
    for mm in before.mismatched_props:
        planned.append({
            "action": "type_mismatch_detected",
            "property_key": mm.property_key,
            "expected_type": mm.expected_type,
            "actual_type": mm.actual_type,
            "note": "Manual review required (or implement explicit migrate path).",
        })

    # Simulate gate
    if safe_mode:
        return DriftHealResult(
            ok=True,
            mode="simulate",
            actions_planned=planned,
            actions_applied=[],
            compliance_after=before.to_dict(),
        )

    # Apply gates
    if write_lock:
        return DriftHealResult(
            ok=False,
            mode="apply",
            actions_planned=planned,
            actions_applied=[],
            blocked_reason="write_lock_enabled",
            compliance_after=before.to_dict(),
        )

    if not allow_schema_writes:
        return DriftHealResult(
            ok=False,
            mode="apply",
            actions_planned=planned,
            actions_applied=[],
            blocked_reason="allow_schema_writes_false",
            compliance_after=before.to_dict(),
        )

    # Apply changes
    _apply_missing_properties(api, db_id, before, required, applied)
    _apply_missing_options(api, db_id, before, applied)

    after = verify_skills_backlog_db(api, db_id)

    log.info("skills_backlog_drift_healed", extra={
        "db_id": db_id,
        "planned": len(planned),
        "applied": len(applied),
        "compliant_after": after.compliant,
    })

    return DriftHealResult(
        ok=True,
        mode="apply",
        actions_planned=planned,
        actions_applied=applied,
        compliance_after=after.to_dict(),
    )


def _apply_missing_properties(
    api: NotionAPI,
    db_id: str,
    before: SkillsBacklogCompliance,
    required: dict,
    applied: list[dict[str, Any]],
) -> None:
    """Create missing properties via database update."""
    update_payload: dict[str, Any] = {"properties": {}}

    for mp in before.missing_props:
        spec = required.get(mp.property_key)
        if not spec:
            continue
        update_payload["properties"][spec.key] = _prop_create_payload(
            spec.notion_type,
            spec.select_options.required if spec.select_options else None,
        )
        applied.append({
            "action": "create_property",
            "property_key": spec.key,
            "type": spec.notion_type,
        })

    if update_payload["properties"]:
        api.update_database(db_id, update_payload)


def _apply_missing_options(
    api: NotionAPI,
    db_id: str,
    before: SkillsBacklogCompliance,
    applied: list[dict[str, Any]],
) -> None:
    """Add missing select/multi-select options."""
    # Group missing options by property
    staged: dict[str, list[str]] = {}
    for mo in before.missing_options:
        staged.setdefault(mo.property_key, []).append(mo.option_name)

    for prop_key, new_opts in staged.items():
        spec = required_prop_map().get(prop_key)
        if not spec or spec.notion_type not in ("select", "multi_select"):
            continue

        api.append_select_options(db_id, {
            "property_name": prop_key,
            "options": new_opts,
            "type": spec.notion_type,
        })

        for opt in new_opts:
            applied.append({
                "action": "add_select_option",
                "property_key": prop_key,
                "option_name": opt,
            })


def _prop_create_payload(
    prop_type: str, required_options: list[str] | None
) -> dict[str, Any]:
    """Build the Notion API payload to create a property of the given type."""
    if prop_type == "rich_text":
        return {"rich_text": {}}
    if prop_type == "url":
        return {"url": {}}
    if prop_type == "number":
        return {"number": {"format": "number"}}
    if prop_type == "date":
        return {"date": {}}
    if prop_type == "select":
        opts = [{"name": o} for o in (required_options or [])]
        return {"select": {"options": opts}}
    if prop_type == "multi_select":
        opts = [{"name": o} for o in (required_options or [])]
        return {"multi_select": {"options": opts}}
    if prop_type == "title":
        return {"title": {}}
    raise ValueError(f"Unsupported prop type: {prop_type}")
