"""Views Registry compliance orchestrator.

Single entrypoint for ensuring all required view keys exist and are healthy:
1. Detect missing/broken view keys
2. If allowed: heal → seed → heal (apply)
3. Respects write_lock + cooldown + runaway guard

Safe-mode by default: simulates all writes unless explicitly allowed.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.views_registry.checks import (
    find_missing_view_keys,
    required_view_keys_minimum,
)
from packages.agencyu.notion.views_registry.healer import ViewsRegistryHealer
from packages.agencyu.notion.views_registry.seeder import ViewsRegistrySeeder
from packages.agencyu.notion.views_registry.spec import minimum_view_specs
from packages.common.config import settings
from packages.common.ids import new_id
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.views_registry.ensure")


def resolve_views_registry_db_id(api: NotionAPI) -> str | None:
    """Find Views Registry DB by title search."""
    try:
        return api.find_database_under_root("", "Views Registry (OpenClaw)")
    except Exception:
        return None


def resolve_views_parent_page_id() -> str | None:
    """Get the parent page where view pages are created."""
    return settings.NOTION_PAGE_DB_ROOT_ID or None


def resolve_db_key_map(api: NotionAPI) -> dict[str, str]:
    """Build db_key → Notion database ID map from manifest."""
    from packages.agencyu.notion.template_manifest import load_manifest

    manifest = load_manifest()
    db_map: dict[str, str] = {}
    for db_key, db_spec in manifest.databases.items():
        title = db_spec.get("title", "")
        if not db_key or not title:
            continue
        try:
            db_id = api.find_database_under_root("", title)
            if db_id:
                db_map[db_key] = db_id
        except Exception:
            pass
    return db_map


class ViewsRegistryEnsurer:
    """Orchestrates detect → heal → seed → heal for Views Registry compliance.

    Usage:
        ensurer = ViewsRegistryEnsurer(api)
        result = ensurer.ensure_cc_compliant(
            allow_mutations=True,
            safe_mode=False,
            reason="daily_reconcile",
        )
    """

    def __init__(self, api: NotionAPI) -> None:
        self.api = api

    def ensure_cc_compliant(
        self,
        *,
        allow_mutations: bool,
        safe_mode: bool = True,
        reason: str = "",
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        """Ensure all required view keys are registered and accessible.

        Flow:
        1. Find missing keys
        2. If none missing → already_compliant
        3. If mutations not allowed → report only
        4. heal → seed → heal (apply or simulate based on safe_mode)
        5. Re-check missing keys

        Args:
            allow_mutations: Whether mutations are permitted by the guard.
            safe_mode: If True, simulate all writes even when allowed.
            reason: Human-readable reason for this run.
            correlation_id: Tracking ID (auto-generated if omitted).
        """
        cid = correlation_id or new_id("vr_ensure")

        # Resolve Notion IDs
        views_registry_db_id = resolve_views_registry_db_id(self.api)
        if not views_registry_db_id:
            return {
                "ok": False,
                "cid": cid,
                "status": "views_registry_db_not_found",
                "reason": reason,
            }

        views_parent_page_id = resolve_views_parent_page_id()
        if not views_parent_page_id:
            return {
                "ok": False,
                "cid": cid,
                "status": "views_parent_page_not_configured",
                "reason": reason,
            }

        db_key_map = resolve_db_key_map(self.api)
        required = required_view_keys_minimum()

        # 1. Detect missing
        missing_before = find_missing_view_keys(
            self.api,
            views_registry_db_id=views_registry_db_id,
            required_keys=required,
        )

        if not missing_before:
            return {
                "ok": True,
                "cid": cid,
                "status": "already_compliant",
                "missing_view_keys": [],
                "mutated": False,
                "reason": reason,
            }

        # 2. Report only if mutations not allowed
        if not allow_mutations:
            return {
                "ok": True,
                "cid": cid,
                "status": "not_compliant_no_mutation",
                "missing_view_keys": missing_before,
                "mutated": False,
                "reason": reason,
            }

        # 3. heal → seed → heal
        specs = minimum_view_specs()
        healer = ViewsRegistryHealer(self.api)
        seeder = ViewsRegistrySeeder(self.api)

        heal_kwargs: dict[str, Any] = {
            "views_registry_db_id": views_registry_db_id,
            "views_parent_page_id": views_parent_page_id,
            "db_key_to_database_id": db_key_map,
            "specs": specs,
            "safe_mode": safe_mode,
            "correlation_id": cid,
        }

        heal1 = healer.heal(**heal_kwargs)

        seed = seeder.seed_minimum(**heal_kwargs)

        heal2 = healer.heal(**heal_kwargs)

        # 4. Re-check (only meaningful if we actually applied)
        if not safe_mode:
            missing_after = find_missing_view_keys(
                self.api,
                views_registry_db_id=views_registry_db_id,
                required_keys=required,
            )
        else:
            missing_after = missing_before  # can't know without applying

        status = "repaired" if not missing_after else "partial_repair"
        if safe_mode:
            status = "simulated"

        log.info("ensure_cc_compliant", extra={
            "status": status,
            "missing_before": len(missing_before),
            "missing_after": len(missing_after),
            "safe_mode": safe_mode,
            "reason": reason,
        })

        return {
            "ok": True,
            "cid": cid,
            "status": status,
            "missing_before": missing_before,
            "missing_after": missing_after,
            "mutated": not safe_mode,
            "safe_mode": safe_mode,
            "reason": reason,
            "heal1": heal1,
            "seed": seed,
            "heal2": heal2,
        }
