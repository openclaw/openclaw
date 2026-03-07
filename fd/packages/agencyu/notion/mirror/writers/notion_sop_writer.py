"""Mirror writer for SOP Library database.

Conservative seed-only writer. SOPs are typically human-curated;
OpenClaw ensures the DB exists and seeds placeholder rows from
manifest-defined required_sops. Never overwrites existing SOP content.

Identity: External URL = "openclaw://sop/<key>"
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.sop")


def _rt(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": {"content": text}}]


class NotionSOPWriter:
    """Seeds required SOP stubs in Notion SOP Library.

    Intentionally conservative:
      - Only creates missing required_sops listed in manifest
      - Never overwrites existing SOP content
    """

    writer_name = "sop"

    def __init__(
        self,
        notion: NotionAPI,
        audit: AuditWriter,
        sop_db_id: str = "",
        required_sops: list[dict[str, Any]] | None = None,
    ) -> None:
        self.notion = notion
        self.audit = audit
        self.db_id = sop_db_id
        self.required = required_sops or []

    def mirror(
        self,
        sources: dict[str, Any],
        correlation_id: str,
        *,
        safe_mode: bool = True,
        max_writes: int = 20,
    ) -> dict[str, Any]:
        """Seed missing required SOPs."""
        writes = 0
        warnings: list[str] = []

        if not self.db_id:
            return {"writes": 0, "warnings": ["no sop_db_id configured"]}

        if not self.required:
            return {"writes": 0, "warnings": ["no required_sops in manifest (ok)"]}

        for sop in self.required:
            if writes >= max_writes:
                break
            key = sop.get("key", "")
            title = sop.get("title", key)
            if not key:
                continue

            row = self._find_by_external_url(key)
            if row:
                continue
            if safe_mode:
                continue

            self._create_sop_stub(key, title, sop.get("category", "Systems"))
            writes += 1
            self.audit.write_event(
                action="notion.sop.seed",
                target_type="notion_page",
                target_id="(new)",
                details={"correlation_id": correlation_id, "sop_key": key},
            )

        return {"writes": writes, "warnings": warnings}

    def _find_by_external_url(self, key: str) -> dict[str, Any] | None:
        resp = self.notion.query_database(
            self.db_id,
            filter_obj={
                "property": "External URL",
                "url": {"equals": f"openclaw://sop/{key}"},
            },
            page_size=1,
        )
        res = resp.get("results", [])
        return res[0] if res else None

    def _create_sop_stub(self, key: str, title: str, category: str) -> None:
        props: dict[str, Any] = {
            "SOP": {"title": _rt(title)},
            "Category": {"select": {"name": category}},
            "Status": {"select": {"name": "Draft"}},
            "External URL": {"url": f"openclaw://sop/{key}"},
        }
        self.notion.create_page(
            {"type": "database_id", "database_id": self.db_id}, props
        )
