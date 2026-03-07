"""Mirror writer for Client Assets database.

Source: GHL custom fields (dropbox_master_folder_url, release_schedule_url, etc.).
Target: Notion Client Assets DB.

Identity: external_key = "ghl_cf:<contact_id>:<field_name>"

Strategy: each distinct link becomes an Asset row. Never deletes; updates URL if changed.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.assets")


def _rt(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": {"content": text}}]


# Map GHL custom field names → Asset Type labels
_FIELD_MAP: dict[str, str] = {
    "dropbox_master_folder_url": "Dropbox Folder",
    "release_schedule_url": "Docs",
    "onboarding_docs_url": "Docs",
    "roster_assets_url": "Docs",
    "brand_assets_url": "Brand Kit",
}


class NotionAssetsWriter:
    """Mirrors client asset links into Notion for visibility.

    Each GHL custom field URL becomes a separate Asset row keyed by
    external_key = ghl_cf:<contact_id>:<field_name>.
    """

    writer_name = "assets"

    def __init__(
        self,
        notion: NotionAPI,
        audit: AuditWriter,
        ids: IdentityMapStore,
        assets_db_id: str = "",
        field_map: dict[str, str] | None = None,
    ) -> None:
        self.notion = notion
        self.audit = audit
        self.ids = ids
        self.db_id = assets_db_id
        self.field_map = field_map or _FIELD_MAP

    def mirror(
        self,
        sources: dict[str, Any],
        correlation_id: str,
        *,
        safe_mode: bool = True,
        max_writes: int = 200,
        max_clients: int = 200,
    ) -> dict[str, Any]:
        """Mirror asset links from GHL custom fields."""
        writes = 0
        warnings: list[str] = []

        if not self.db_id:
            return {"writes": 0, "warnings": ["no assets_db_id configured"]}

        ghl = sources.get("ghl")
        if not ghl:
            return {"writes": 0, "warnings": ["no ghl source provided"]}

        contacts = (
            ghl.list_client_contacts(limit=max_clients)
            if hasattr(ghl, "list_client_contacts")
            else []
        )

        for c in contacts:
            if writes >= max_writes:
                break
            contact_id = str(c.get("id") or "")
            if not contact_id:
                continue

            cfs = c.get("custom_fields", {}) or {}
            client_key = cfs.get("client_key") or self.ids.resolve_chain(
                ghl_contact_id=contact_id
            )
            if not client_key:
                warnings.append(f"assets: missing client_key for ghl_contact_id={contact_id}")
                continue

            self.ids.upsert_mapping(
                domain="client",
                external_id=str(client_key),
                ghl_contact_id=contact_id,
            )

            for field_name, asset_type in self.field_map.items():
                url = cfs.get(field_name)
                if not url:
                    continue

                ext_key = f"ghl_cf:{contact_id}:{field_name}"
                row = self._find_by_external_key(ext_key)

                if not row:
                    if safe_mode:
                        continue
                    self._create_asset_row(client_key, asset_type, url, ext_key)
                    writes += 1
                    self.audit.write_event(
                        action="notion.assets.create",
                        target_type="notion_page",
                        target_id="(new)",
                        details={"correlation_id": correlation_id, "external_key": ext_key},
                    )
                else:
                    if safe_mode:
                        continue
                    existing_url = (
                        (row.get("properties", {}).get("URL", {}) or {}).get("url")
                    )
                    if existing_url != url:
                        self.notion.update_page(row["id"], {"URL": {"url": url}})
                        writes += 1
                        self.audit.write_event(
                            action="notion.assets.update",
                            target_type="notion_page",
                            target_id=row["id"],
                            details={"correlation_id": correlation_id, "external_key": ext_key},
                        )

        return {"writes": writes, "warnings": warnings}

    def _find_by_external_key(self, external_key: str) -> dict[str, Any] | None:
        resp = self.notion.query_database(
            self.db_id,
            filter_obj={"property": "external_key", "rich_text": {"equals": external_key}},
            page_size=1,
        )
        res = resp.get("results", [])
        return res[0] if res else None

    def _create_asset_row(
        self, client_key: str, asset_type: str, url: str, external_key: str
    ) -> None:
        props: dict[str, Any] = {
            "Asset": {"title": _rt(asset_type)},
            "Type": {"select": {"name": asset_type}},
            "URL": {"url": url},
            "external_key": {"rich_text": _rt(external_key)},
        }
        self.notion.create_page(
            {"type": "database_id", "database_id": self.db_id}, props
        )
