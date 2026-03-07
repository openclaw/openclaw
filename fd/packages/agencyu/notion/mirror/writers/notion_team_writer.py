"""Mirror writer for Team Directory database.

Conservative seed-only writer. If team is already maintained in Notion,
OpenClaw should NOT overwrite. It can ensure presence of required roles
and seed active members from a config source.

Identity: Email (unique per member)
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.team")


def _rt(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": {"content": text}}]


class NotionTeamWriter:
    """Seeds/mirrors team directory in Notion.

    Conservative: only creates missing members, never overwrites existing.
    """

    writer_name = "team"

    def __init__(
        self,
        notion: NotionAPI,
        audit: AuditWriter,
        team_db_id: str = "",
    ) -> None:
        self.notion = notion
        self.audit = audit
        self.db_id = team_db_id

    def mirror(
        self,
        sources: dict[str, Any],
        correlation_id: str,
        *,
        safe_mode: bool = True,
        max_writes: int = 25,
    ) -> dict[str, Any]:
        """Seed missing team members from roster source."""
        writes = 0
        warnings: list[str] = []

        if not self.db_id:
            return {"writes": 0, "warnings": ["no team_db_id configured"]}

        roster = sources.get("team_roster")
        if not roster:
            return {"writes": 0, "warnings": ["no team_roster provided (ok)"]}

        for member in roster:
            if writes >= max_writes:
                break
            email = member.get("email")
            member_name = member.get("name") or email or "Team Member"
            if not email:
                continue

            row = self._find_by_email(email)
            if row:
                continue
            if safe_mode:
                continue

            self._create_member(member_name, member)
            writes += 1
            self.audit.write_event(
                action="notion.team.seed",
                target_type="notion_page",
                target_id="(new)",
                details={"correlation_id": correlation_id, "email": email},
            )

        return {"writes": writes, "warnings": warnings}

    def _find_by_email(self, email: str) -> dict[str, Any] | None:
        resp = self.notion.query_database(
            self.db_id,
            filter_obj={"property": "Email", "email": {"equals": email}},
            page_size=1,
        )
        res = resp.get("results", [])
        return res[0] if res else None

    def _create_member(self, member_name: str, member: dict[str, Any]) -> None:
        props: dict[str, Any] = {
            "Name": {"title": _rt(member_name)},
            "Status": {"select": {"name": member.get("status", "Active")}},
            "Role": {"select": {"name": member.get("role", "Designer")}},
            "Email": {"email": member.get("email")},
        }
        if member.get("capacity"):
            props["Capacity (hrs/wk)"] = {"number": float(member["capacity"])}
        self.notion.create_page(
            {"type": "database_id", "database_id": self.db_id}, props
        )
