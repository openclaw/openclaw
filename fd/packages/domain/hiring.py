from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.logging import get_logger

log = get_logger("hiring")

# Default role definitions (JD 2.0 format)
DEFAULT_ROLES: list[dict[str, Any]] = [
    {
        "role_id": "motion_designer",
        "title": "Motion Designer",
        "description": "Creates motion graphics and animated content for social media",
        "kpis": {
            "deliverables_per_week": 8,
            "on_time_rate": 0.90,
            "revision_rate_max": 0.20,
            "response_time_hours": 4,
        },
        "tools_required": ["after_effects", "premiere_pro", "figma"],
        "capacity_units": 3,
    },
    {
        "role_id": "video_editor",
        "title": "Video Editor",
        "description": "Edits long-form and short-form video content",
        "kpis": {
            "deliverables_per_week": 10,
            "on_time_rate": 0.90,
            "revision_rate_max": 0.20,
            "response_time_hours": 4,
        },
        "tools_required": ["premiere_pro", "davinci_resolve"],
        "capacity_units": 4,
    },
    {
        "role_id": "graphic_designer",
        "title": "Graphic Designer",
        "description": "Creates static social media content and brand assets",
        "kpis": {
            "deliverables_per_week": 12,
            "on_time_rate": 0.90,
            "revision_rate_max": 0.15,
            "response_time_hours": 4,
        },
        "tools_required": ["figma", "photoshop", "illustrator"],
        "capacity_units": 4,
    },
]


def get_role_definitions() -> list[dict[str, Any]]:
    """Return all role definitions (JD 2.0 format)."""
    return DEFAULT_ROLES


def get_role_by_id(role_id: str) -> dict[str, Any] | None:
    """Look up a role definition by ID."""
    for role in DEFAULT_ROLES:
        if role["role_id"] == role_id:
            return role
    return None


def check_capacity_needs(
    conn: sqlite3.Connection,
    *,
    role_id: str,
    threshold: float = 0.8,
) -> dict[str, Any]:
    """Check if hiring is needed for a role based on current capacity.

    Returns capacity status and whether hiring is recommended.
    """
    role = get_role_by_id(role_id)
    if not role:
        return {"error": "unknown_role", "role_id": role_id}

    # Count active team members with this role
    rows = conn.execute(
        "SELECT * FROM team_capacity WHERE enabled=1 AND roles_json LIKE ?",
        (f'%"{role_id}"%',),
    ).fetchall()

    total_capacity = sum(role["capacity_units"] for _ in rows) if rows else 0
    active_jobs = sum(r["active_jobs"] for r in rows) if rows else 0

    utilization = active_jobs / total_capacity if total_capacity > 0 else 1.0
    needs_hire = utilization >= threshold

    return {
        "role_id": role_id,
        "team_members": len(rows) if rows else 0,
        "total_capacity_units": total_capacity,
        "active_jobs": active_jobs,
        "utilization": round(utilization, 4),
        "threshold": threshold,
        "needs_hire": needs_hire,
    }


def get_intake_form_schema() -> dict[str, Any]:
    """Return the hiring intake form schema."""
    return {
        "fields": [
            {"name": "name", "type": "text", "required": True},
            {"name": "email", "type": "email", "required": True},
            {"name": "portfolio_url", "type": "url", "required": True},
            {"name": "role_applied", "type": "select", "required": True,
             "options": [r["role_id"] for r in DEFAULT_ROLES]},
            {"name": "years_experience", "type": "int", "required": True},
            {"name": "tools_proficiency", "type": "multiselect", "required": True},
            {"name": "availability_hours", "type": "int", "required": True},
            {"name": "rate_expectation", "type": "text", "required": True},
            {"name": "loom_url", "type": "url", "required": True},
        ],
        "loom_rubric": {
            "communication_clarity": {"weight": 0.25, "max_score": 5},
            "portfolio_quality": {"weight": 0.30, "max_score": 5},
            "tool_proficiency": {"weight": 0.20, "max_score": 5},
            "culture_fit": {"weight": 0.15, "max_score": 5},
            "availability_match": {"weight": 0.10, "max_score": 5},
        },
    }
