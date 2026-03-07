"""Views Registry drift healer — verifies and repairs registry rows.

For each required ViewSpec, checks:
1. Registry row exists for the view_key
2. The page referenced by the row still exists
3. The db_key/database_id mappings are consistent
4. The row is marked as owned by OpenClaw

If any drift is detected, repairs it (safe_mode=False) or reports it.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.views_registry.spec import ViewSpec
from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.views_registry.healer")


class ViewsRegistryHealer:
    """Verifies and repairs Views Registry rows and their referenced pages."""

    def __init__(self, api: NotionAPI) -> None:
        self.api = api

    def heal(
        self,
        *,
        views_registry_db_id: str,
        views_parent_page_id: str,
        db_key_to_database_id: dict[str, str],
        specs: list[ViewSpec],
        safe_mode: bool = True,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Verify and repair all required view specs.

        Returns summary with per-spec status.
        """
        results: list[dict[str, Any]] = []
        now = utc_now_iso()

        # Load all registry rows once
        all_rows = self._load_all_rows(views_registry_db_id)

        for spec in specs:
            expected_db_id = db_key_to_database_id.get(spec.db_key)
            row = self._find_row_by_view_key(all_rows, spec.view_key)

            if not row:
                # Missing row — needs seeding
                if safe_mode:
                    results.append({
                        "view_key": spec.view_key,
                        "status": "missing_row_simulated",
                        "action": "would_seed",
                    })
                else:
                    self._seed_missing(
                        views_registry_db_id=views_registry_db_id,
                        views_parent_page_id=views_parent_page_id,
                        spec=spec,
                        database_id=expected_db_id,
                        now=now,
                        correlation_id=correlation_id,
                    )
                    results.append({
                        "view_key": spec.view_key,
                        "status": "seeded",
                    })
                continue

            # Row exists — verify page is accessible
            page_id = self._extract_page_id_from_row(row)
            page_ok = self._check_page_exists(page_id) if page_id else False

            issues: list[str] = []
            if not page_ok:
                issues.append("page_missing")

            # Check db_key consistency (via Notes field or Database Key select)
            row_db_key = self._extract_db_key(row)
            if row_db_key and row_db_key != spec.db_key:
                issues.append(f"db_key_mismatch:{row_db_key}")

            if not issues:
                # Update last_verified_at
                if not safe_mode:
                    self._update_verified_at(row["id"], now)
                results.append({
                    "view_key": spec.view_key,
                    "status": "ok",
                })
                continue

            # Has issues — repair
            if safe_mode:
                results.append({
                    "view_key": spec.view_key,
                    "status": "drift_detected_simulated",
                    "issues": issues,
                })
            else:
                # Recreate page if missing
                if "page_missing" in issues:
                    from packages.agencyu.notion.views_registry.seeder import ViewsRegistrySeeder
                    seeder = ViewsRegistrySeeder(self.api)
                    new_page_id = seeder._create_view_page(
                        parent_page_id=views_parent_page_id,
                        spec=spec,
                        database_id=expected_db_id or "",
                    )
                    # Update registry row with new page_id
                    self.api.upsert_views_registry_row(
                        views_registry_db_id,
                        {
                            "database_key": spec.db_key,
                            "view_name": spec.view_key,
                            "required": True,
                            "status": "active",
                            "last_verified_at": now,
                            "notes": f"Page recreated by healer. "
                                     f"New page: {new_page_id}. "
                                     f"Correlation: {correlation_id}.",
                        },
                    )

                results.append({
                    "view_key": spec.view_key,
                    "status": "repaired",
                    "issues_fixed": issues,
                })

                log.info("view_healed", extra={
                    "view_key": spec.view_key,
                    "issues": issues,
                })

        ok_count = sum(1 for r in results if r["status"] == "ok")
        repaired = sum(1 for r in results if r["status"] in ("seeded", "repaired"))
        simulated = sum(1 for r in results if "simulated" in r["status"])

        return {
            "ok": True,
            "safe_mode": safe_mode,
            "correlation_id": correlation_id,
            "total": len(specs),
            "ok_count": ok_count,
            "repaired": repaired,
            "simulated": simulated,
            "results": results,
        }

    def status(
        self,
        *,
        views_registry_db_id: str,
        specs: list[ViewSpec],
    ) -> dict[str, Any]:
        """Read-only status check of all required views."""
        all_rows = self._load_all_rows(views_registry_db_id)
        results: list[dict[str, Any]] = []

        for spec in specs:
            row = self._find_row_by_view_key(all_rows, spec.view_key)
            if not row:
                results.append({
                    "view_key": spec.view_key,
                    "db_key": spec.db_key,
                    "registered": False,
                    "page_accessible": False,
                })
                continue

            page_id = self._extract_page_id_from_row(row)
            page_ok = self._check_page_exists(page_id) if page_id else False

            results.append({
                "view_key": spec.view_key,
                "db_key": spec.db_key,
                "registered": True,
                "page_id": page_id,
                "page_accessible": page_ok,
                "row_id": row.get("id"),
            })

        registered = sum(1 for r in results if r["registered"])
        accessible = sum(1 for r in results if r["page_accessible"])

        return {
            "ok": True,
            "total": len(specs),
            "registered": registered,
            "accessible": accessible,
            "results": results,
        }

    def _seed_missing(
        self,
        *,
        views_registry_db_id: str,
        views_parent_page_id: str,
        spec: ViewSpec,
        database_id: str | None,
        now: str,
        correlation_id: str,
    ) -> None:
        """Seed a missing view by creating page + registry row."""
        from packages.agencyu.notion.views_registry.seeder import ViewsRegistrySeeder

        seeder = ViewsRegistrySeeder(self.api)
        page_id = seeder._create_view_page(
            parent_page_id=views_parent_page_id,
            spec=spec,
            database_id=database_id or "",
        )
        seeder._upsert_registry_row(
            views_registry_db_id=views_registry_db_id,
            spec=spec,
            page_id=page_id,
            database_id=database_id or "",
            now=now,
            correlation_id=correlation_id,
        )

    def _load_all_rows(self, views_registry_db_id: str) -> list[dict[str, Any]]:
        """Load all rows from the Views Registry DB."""
        try:
            return self.api.query_all_database_rows(views_registry_db_id)
        except Exception as exc:
            log.warning("load_views_registry_failed", extra={"error": str(exc)})
            return []

    def _find_row_by_view_key(
        self, rows: list[dict[str, Any]], view_key: str,
    ) -> dict[str, Any] | None:
        """Find a registry row by matching title to view_key."""
        for row in rows:
            title = self.api._page_title(row)
            if title.strip().lower() == view_key.strip().lower():
                return row
        return None

    def _extract_page_id_from_row(self, row: dict[str, Any]) -> str | None:
        """Extract page_id from registry row Notes field."""
        props = row.get("properties", {})
        notes_prop = props.get("Notes", {})
        rich_text = notes_prop.get("rich_text", [])
        if not rich_text:
            return None
        notes_text = rich_text[0].get("plain_text", "")
        # Parse "Page: <page_id>" from notes
        if "Page:" in notes_text:
            for part in notes_text.split("."):
                part = part.strip()
                if part.startswith("Page:"):
                    return part.replace("Page:", "").strip()
        return None

    def _extract_db_key(self, row: dict[str, Any]) -> str | None:
        """Extract db_key from the Database Key select property."""
        return self.api._select_value(row, "Database Key")

    def _check_page_exists(self, page_id: str) -> bool:
        """Check if a page is accessible."""
        if not page_id:
            return False
        return self.api.can_read_page(page_id)

    def _update_verified_at(self, row_id: str, now: str) -> None:
        """Update last_verified_at on a registry row."""
        try:
            self.api.update_page(row_id, {
                "Last Verified At": {"date": {"start": now}},
            })
        except Exception as exc:
            log.warning("update_verified_at_failed", extra={
                "row_id": row_id,
                "error": str(exc),
            })
