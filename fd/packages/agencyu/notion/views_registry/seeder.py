"""Views Registry seeder — creates view pages + upserts registry rows.

For each required ViewSpec:
1. Creates a view page under the databases parent page (or finds existing).
2. Writes a clean template on that page (heading + purpose + DB link).
3. Upserts a row in the Views Registry DB with view_key, db_key, page_id.

Safe-mode by default: simulates all writes.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.mirror.page_blocks import (
    divider,
    heading_1,
    paragraph,
)
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.views_registry.spec import ViewSpec
from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.views_registry.seeder")


class ViewsRegistrySeeder:
    """Creates view pages and seeds Views Registry DB rows.

    View pages are stable Notion pages that widgets link to.
    They are NOT Notion internal views — just pages with instructions
    and an optional embedded database link.
    """

    def __init__(self, api: NotionAPI) -> None:
        self.api = api

    def seed_minimum(
        self,
        *,
        views_registry_db_id: str,
        views_parent_page_id: str,
        db_key_to_database_id: dict[str, str],
        specs: list[ViewSpec],
        safe_mode: bool = True,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Seed view pages and registry rows for all specs.

        Args:
            views_registry_db_id: ID of the Views Registry database.
            views_parent_page_id: Parent page where view pages are created.
            db_key_to_database_id: Map of db_key -> Notion database ID.
            specs: List of ViewSpecs to seed.
            safe_mode: If True, simulate only.
            correlation_id: Tracking ID.
        """
        results: list[dict[str, Any]] = []
        now = utc_now_iso()

        for spec in specs:
            database_id = db_key_to_database_id.get(spec.db_key)
            if not database_id:
                results.append({
                    "view_key": spec.view_key,
                    "status": "blocked_missing_database",
                    "db_key": spec.db_key,
                })
                continue

            # Check if registry row already exists
            existing_row = self._find_registry_row(
                views_registry_db_id, spec.view_key,
            )

            if existing_row:
                results.append({
                    "view_key": spec.view_key,
                    "status": "already_registered",
                    "row_id": existing_row.get("id"),
                })
                continue

            if safe_mode:
                results.append({
                    "view_key": spec.view_key,
                    "status": "simulated",
                    "would_create_page": True,
                    "would_upsert_registry_row": True,
                })
                continue

            # Create view page
            page_id = self._create_view_page(
                parent_page_id=views_parent_page_id,
                spec=spec,
                database_id=database_id,
            )

            # Upsert registry row
            self._upsert_registry_row(
                views_registry_db_id=views_registry_db_id,
                spec=spec,
                page_id=page_id,
                database_id=database_id,
                now=now,
                correlation_id=correlation_id,
            )

            page_url = f"https://notion.so/{page_id.replace('-', '')}"
            results.append({
                "view_key": spec.view_key,
                "status": "seeded",
                "page_id": page_id,
                "page_url": page_url,
            })

            log.info("view_seeded", extra={
                "view_key": spec.view_key,
                "page_id": page_id,
                "db_key": spec.db_key,
            })

        seeded = sum(1 for r in results if r["status"] == "seeded")
        simulated = sum(1 for r in results if r["status"] == "simulated")
        skipped = sum(1 for r in results if r["status"] in ("already_registered", "blocked_missing_database"))

        return {
            "ok": True,
            "safe_mode": safe_mode,
            "correlation_id": correlation_id,
            "total": len(specs),
            "seeded": seeded,
            "simulated": simulated,
            "skipped": skipped,
            "results": results,
        }

    def _find_registry_row(
        self, views_registry_db_id: str, view_key: str,
    ) -> dict[str, Any] | None:
        """Find existing Views Registry row by view_key (Name/title match)."""
        try:
            rows = self.api.query_all_database_rows(views_registry_db_id)
            for row in rows:
                title = self.api._page_title(row)
                # Match by title containing the view_key pattern
                props = row.get("properties", {})
                # Check Database Key select matches our convention
                # The existing schema uses Name as title = view_name
                # We'll match on title containing the view_key
                db_key_prop = props.get("Database Key", {})
                if db_key_prop.get("type") == "select" and db_key_prop.get("select"):
                    # Try to find by examining all rows
                    pass
                # For now, match by page title
                if title.strip().lower() == view_key.strip().lower():
                    return row
        except Exception:
            pass
        return None

    def _create_view_page(
        self,
        *,
        parent_page_id: str,
        spec: ViewSpec,
        database_id: str,
    ) -> str:
        """Create a view page with template content."""
        parent = {"type": "page_id", "page_id": parent_page_id}
        properties = {
            "title": {"title": [{"text": {"content": spec.page_title}}]},
        }
        page_id = self.api.create_page(parent, properties)

        # Write template blocks
        db_url = f"https://notion.so/{database_id.replace('-', '')}"
        blocks = [
            heading_1(f"{spec.page_title}"),
            paragraph(f"View Key: {spec.view_key}", color="gray"),
            paragraph(f"Purpose: {spec.purpose}", color="gray"),
            paragraph(f"Database: {spec.db_key}", color="gray"),
            divider(),
            paragraph(f"Open the database: {db_url}"),
            paragraph(
                "You can create a Notion view manually on this page "
                "(table/board/calendar) and keep its layout how you like. "
                "OpenClaw verifies this page exists and is linked, "
                "not the internal view object.",
                color="gray",
            ),
        ]
        self.api.append_block_children(page_id, blocks)

        return page_id

    def _upsert_registry_row(
        self,
        *,
        views_registry_db_id: str,
        spec: ViewSpec,
        page_id: str,
        database_id: str,
        now: str,
        correlation_id: str,
    ) -> None:
        """Upsert a row in the Views Registry DB."""
        self.api.upsert_views_registry_row(
            views_registry_db_id,
            {
                "database_key": spec.db_key,
                "view_name": spec.view_key,
                "required": True,
                "status": "active",
                "last_verified_at": now,
                "notes": f"Auto-seeded by OpenClaw. Purpose: {spec.purpose}. "
                         f"Page: {page_id}. Correlation: {correlation_id}.",
            },
        )
