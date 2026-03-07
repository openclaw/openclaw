"""Portal Block Healer — keeps client portal pages compliant and clean.

Uses replace-between-markers discipline to manage OpenClaw-owned sections
without overwriting human content.

Marker keys managed:
  PORTAL_START_HERE, PORTAL_PROJECTS_MIRROR, PORTAL_FINANCE_MIRROR,
  PORTAL_DROPBOX_MASTER, PORTAL_DELIVERY_LINKS, PORTAL_LINKS_JSON,
  PORTAL_SYSTEM_NOTES

Design: uses the property-text approach — a single rich_text property
("Notes") on the Clients row holds the canonical marker-managed text.
This is deterministic and easy to drift-heal.
"""
from __future__ import annotations

import json
from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.mirror.block_markers import replace_between_markers_text
from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.portal_block_healer")


class PortalBlockHealer:
    """Ensures each Client Portal page contains required OpenClaw-owned sections.

    Uses replace-between-markers so the page stays clean and deterministic.
    """

    def __init__(
        self,
        notion: NotionAPI,
        audit: AuditWriter,
        ids: IdentityMapStore,
        clients_db_id: str = "",
        assets_db_id: str = "",
    ) -> None:
        self.notion = notion
        self.audit = audit
        self.ids = ids
        self.clients_db_id = clients_db_id
        self.assets_db_id = assets_db_id

    def heal_all_clients(
        self,
        sources: dict[str, Any],
        correlation_id: str,
        *,
        safe_mode: bool = True,
        max_clients: int = 200,
    ) -> dict[str, Any]:
        """Heal portal sections for all clients."""
        writes = 0
        warnings: list[str] = []

        if not self.clients_db_id:
            return {"writes": 0, "warnings": ["no clients_db_id configured"]}

        ghl = sources.get("ghl")
        clients = self._list_clients(limit=max_clients)

        for row in clients:
            client_key = self._rich_text_value(row, "client_key")
            if not client_key:
                continue

            portal_body = self._rich_text_value(row, "Notes") or ""

            # Build standard sections via marker replacement
            portal_body_new = portal_body
            portal_body_new = replace_between_markers_text(
                portal_body_new, "PORTAL_START_HERE",
                self._block_start_here(client_key),
            )
            portal_body_new = replace_between_markers_text(
                portal_body_new, "PORTAL_PROJECTS_MIRROR",
                self._block_projects_mirror(client_key),
            )
            portal_body_new = replace_between_markers_text(
                portal_body_new, "PORTAL_FINANCE_MIRROR",
                self._block_finance_mirror(client_key),
            )

            # Dropbox master folder link from GHL custom field or Assets DB
            dropbox_url = None
            if ghl and hasattr(ghl, "get_custom_field_by_client_key"):
                dropbox_url = ghl.get_custom_field_by_client_key(
                    client_key, "dropbox_master_folder_url"
                )
            if not dropbox_url and self.assets_db_id:
                dropbox_url = self._find_asset_url("Dropbox Folder")

            portal_body_new = replace_between_markers_text(
                portal_body_new, "PORTAL_DROPBOX_MASTER",
                self._block_dropbox(dropbox_url),
            )
            portal_body_new = replace_between_markers_text(
                portal_body_new, "PORTAL_DELIVERY_LINKS",
                self._block_delivery_links_stub(),
            )
            portal_body_new = replace_between_markers_text(
                portal_body_new, "PORTAL_LINKS_JSON",
                self._block_links_json_stub(),
            )
            portal_body_new = replace_between_markers_text(
                portal_body_new, "PORTAL_SYSTEM_NOTES",
                self._block_system_notes(),
            )

            if portal_body_new != portal_body:
                if safe_mode:
                    continue
                self.notion.update_page(
                    row["id"],
                    {
                        "Notes": {
                            "rich_text": [
                                {"type": "text", "text": {"content": portal_body_new}}
                            ]
                        }
                    },
                )
                writes += 1
                self.audit.write_event(
                    action="notion.portal.heal",
                    target_type="notion_page",
                    target_id=row["id"],
                    details={"correlation_id": correlation_id, "client_key": client_key},
                )

        return {"writes": writes, "warnings": warnings}

    # ─────────────────────────────────────────
    # Block builders (plain text sections)
    # ─────────────────────────────────────────

    def _block_start_here(self, client_key: str) -> str:
        now = utc_now_iso()
        return (
            "Start Here\n"
            "- Use the Trello board as the source of truth for requests, status, and delivery.\n"
            "- This portal mirrors key links and status for visibility.\n"
            "- If you cannot find a deliverable, check the Trello card comments in the relevant stage.\n"
            f'\n(Meta)\n{{"client_key":"{client_key}","updated_ts":"{now}"}}'
        )

    def _block_projects_mirror(self, client_key: str) -> str:
        return (
            "Projects & Requests (Mirror)\n"
            "- Requests: new items awaiting work\n"
            "- In Progress: currently being produced\n"
            "- Needs Review / Feedback: awaiting client input\n"
            "- Approved / Ready for Delivery: approved, waiting on release date or final packaging\n"
            "- Published / Delivered: completed history\n"
            f'\n(Meta)\n{{"client_key":"{client_key}","mirror":"tasks"}}'
        )

    def _block_finance_mirror(self, client_key: str) -> str:
        return (
            "Invoices & Payments (Mirror)\n"
            "- Stripe is the revenue source of truth.\n"
            "- QuickBooks is the accounting source of truth.\n"
            "- This section is visibility-only.\n"
            f'\n(Meta)\n{{"client_key":"{client_key}","mirror":"finance"}}'
        )

    def _block_dropbox(self, url: str | None) -> str:
        if not url:
            return (
                "Dropbox Master Folder\n"
                "- Not yet linked.\n"
                "- If you have a master folder link, provide it in the Trello References card or via onboarding.\n"
                '\n(Meta)\n{"type":"dropbox_master","status":"missing"}'
            )
        return (
            "Dropbox Master Folder\n"
            f"- {url}\n"
            '\n(Meta)\n{"type":"dropbox_master","status":"linked"}'
        )

    def _block_delivery_links_stub(self) -> str:
        return (
            "Delivery Links\n"
            "- (This block is maintained by OpenClaw. Final and draft links will appear here when posted.)\n"
            '\n(Meta)\n{"type":"delivery_links","version":1}'
        )

    def _block_links_json_stub(self) -> str:
        now = utc_now_iso()
        obj = {"drafts": [], "finals": [], "updated_ts": now, "version": 1}
        return json.dumps(obj, indent=2)

    def _block_system_notes(self) -> str:
        return (
            "System Notes\n"
            "- Do not edit database schemas manually. OpenClaw owns schema changes.\n"
            "- If a section is missing, OpenClaw will restore it during reconcile.\n"
            '\n(Meta)\n{"type":"system_notes"}'
        )

    # ─────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────

    def _list_clients(self, limit: int = 200) -> list[dict[str, Any]]:
        resp = self.notion.query_database(
            self.clients_db_id, page_size=min(limit, 100)
        )
        return resp.get("results", [])

    def _rich_text_value(self, row: dict[str, Any], prop: str) -> str | None:
        p = row.get("properties", {}).get(prop, {}) or {}
        rt = p.get("rich_text") or p.get("title") or []
        if not rt:
            return None
        try:
            return "".join(x.get("plain_text", "") for x in rt)
        except Exception:
            return None

    def _find_asset_url(self, asset_type: str) -> str | None:
        if not self.assets_db_id:
            return None
        resp = self.notion.query_database(
            self.assets_db_id,
            filter_obj={"property": "Type", "select": {"equals": asset_type}},
            page_size=1,
        )
        for r in resp.get("results", []):
            u = (r.get("properties", {}).get("URL", {}) or {}).get("url")
            if u:
                return u
        return None
