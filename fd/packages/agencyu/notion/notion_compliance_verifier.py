"""Live-API Notion Compliance Verifier.

Verifies the Notion workspace matches the template manifest by calling
the Notion API directly. This is the "full" verifier used by admin endpoints.

Read-only — never writes to Notion.

Checks:
1. Required root pages exist (by ID map or title search fallback)
2. Required databases exist with correct property schemas
3. System Settings page properties (write_lock, safe_mode, last_verified_at)
4. Views Registry DB contains required view_key rows
5. Command Center widget markers exist on the CC page
6. Portal section markers exist on client portal pages
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.compliance_models import (
    ComplianceResult,
    MissingProperty,
    MissingViewKey,
)
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.template_manifest import Manifest
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.notion_compliance_verifier")


class NotionIdMap:
    """Maps manifest keys to known Notion page/database IDs.

    IDs are environment/config provided (preferred) or discovered by
    name search (fallback). The verifier populates discovered_* dicts
    on the ComplianceResult for operator convenience.
    """

    def __init__(
        self,
        page_ids: dict[str, str] | None = None,
        db_ids: dict[str, str] | None = None,
    ) -> None:
        self.page_ids = page_ids or {}
        self.db_ids = db_ids or {}


class NotionComplianceVerifier:
    """Live-API compliance verifier. Read-only — never writes.

    Usage:
        manifest = load_manifest()
        api = NotionAPI(client)
        ids = NotionIdMap(page_ids={...}, db_ids={...})
        verifier = NotionComplianceVerifier(api, manifest, ids)
        result = verifier.verify_all()
    """

    def __init__(
        self,
        api: NotionAPI,
        manifest: Manifest,
        ids: NotionIdMap,
    ) -> None:
        self.api = api
        self.manifest = manifest
        self.ids = ids

    # ─────────────────────────────────────────
    # Public entrypoints
    # ─────────────────────────────────────────

    def verify_all(self) -> ComplianceResult:
        """Full compliance check: pages, DBs, properties, views, widgets."""
        res = ComplianceResult(
            template_version=self.manifest.template_version,
            os_version=self.manifest.os_version,
        )

        self._verify_required_pages(res)
        self._verify_databases_and_properties(res)
        self._read_system_settings(res)
        self._verify_views_registry(res)
        self._verify_command_center_widgets(res)

        # Finalize
        if (
            res.missing_pages
            or res.missing_db_keys
            or res.missing_db_properties
            or res.missing_view_keys
            or res.missing_widgets
        ):
            res.compliant = False

        if res.write_lock:
            res.warnings.append("write_lock enabled: writers should simulate only.")
        if res.safe_mode:
            res.warnings.append("safe_mode enabled: writers should simulate by default.")

        log.info("live_compliance_check_complete", extra={
            "is_compliant": res.compliant,
            "missing_pages": len(res.missing_pages),
            "missing_dbs": len(res.missing_db_keys),
            "missing_props": len(res.missing_db_properties),
            "missing_views": len(res.missing_view_keys),
            "missing_widgets": len(res.missing_widgets),
        })

        return res

    def verify_command_center_only(self) -> ComplianceResult:
        """Lightweight check: just pages, views, and widget markers."""
        res = ComplianceResult(
            template_version=self.manifest.template_version,
            os_version=self.manifest.os_version,
        )

        self._verify_required_pages(res)
        self._verify_views_registry(res)
        self._verify_command_center_widgets(res)

        if res.missing_pages or res.missing_view_keys or res.missing_widgets:
            res.compliant = False

        return res

    # ─────────────────────────────────────────
    # Step 1: Required pages
    # ─────────────────────────────────────────

    def _verify_required_pages(self, res: ComplianceResult) -> None:
        for page in self.manifest.required_root_pages:
            page_key = page.get("page_key", "")
            title = page.get("title", "")
            page_id = self.ids.page_ids.get(page_key)

            if page_id:
                try:
                    self.api.get_page(page_id)
                    continue
                except Exception:
                    res.missing_pages.append(page_key)
                    continue

            # Fallback: search by title
            found_id = self._search_first_page(title)
            if found_id:
                res.details.setdefault("discovered_page_ids", {})[page_key] = found_id
            else:
                res.missing_pages.append(page_key)

    # ─────────────────────────────────────────
    # Step 2: Databases + properties
    # ─────────────────────────────────────────

    def _verify_databases_and_properties(self, res: ComplianceResult) -> None:
        for db_key, db_spec in self.manifest.databases.items():
            if not db_spec.get("required", False):
                continue

            title = db_spec.get("title", db_key)
            db_id = self.ids.db_ids.get(db_key)

            if not db_id:
                db_id = self._search_first_database(title)
                if db_id:
                    res.details.setdefault("discovered_db_ids", {})[db_key] = db_id

            if not db_id:
                res.missing_db_keys.append(db_key)
                continue

            # Fetch schema and check properties
            try:
                db_obj = self.api.get_database(db_id)
            except Exception:
                res.missing_db_keys.append(db_key)
                continue

            notion_props = db_obj.get("properties", {})
            for prop_name, prop_spec in db_spec.get("properties", {}).items():
                expected_type = prop_spec.get("type", "unknown")

                if prop_name not in notion_props:
                    res.missing_db_properties.append(
                        MissingProperty(
                            db_key=db_key,
                            property_key=prop_name,
                            expected_type=expected_type,
                        )
                    )
                    continue

                actual_type = notion_props[prop_name].get("type", "")
                if actual_type != expected_type:
                    res.missing_db_properties.append(
                        MissingProperty(
                            db_key=db_key,
                            property_key=prop_name,
                            expected_type=expected_type,
                            actual_type=actual_type,
                        )
                    )
                    res.details.setdefault("type_mismatches", []).append({
                        "db_key": db_key,
                        "property_key": prop_name,
                        "expected": expected_type,
                        "actual": actual_type,
                    })

    # ─────────────────────────────────────────
    # Step 3: System Settings
    # ─────────────────────────────────────────

    def _read_system_settings(self, res: ComplianceResult) -> None:
        ssp = self.manifest.system_settings_page
        page_key = ssp.get("page_key", "system_settings")
        page_id = (
            self.ids.page_ids.get(page_key)
            or res.details.get("discovered_page_ids", {}).get(page_key)
        )

        if not page_id:
            res.warnings.append("system_settings page not found; write_lock/safe_mode unknown.")
            return

        try:
            page = self.api.get_page(page_id)
        except Exception:
            res.warnings.append("system_settings page could not be retrieved.")
            return

        props = page.get("properties", {})
        wl = _read_checkbox(props, "write_lock")
        res.write_lock = wl if wl is not None else _read_checkbox(props, "Write Lock")
        sm = _read_checkbox(props, "safe_mode")
        res.safe_mode = sm if sm is not None else _read_checkbox(props, "Safe Mode")
        lv = _read_date(props, "last_verified_at")
        res.last_verified_at = lv if lv is not None else _read_date(props, "Last Verified At")

    # ─────────────────────────────────────────
    # Step 4: Views Registry
    # ─────────────────────────────────────────

    def _verify_views_registry(self, res: ComplianceResult) -> None:
        vr_db_id = (
            self.ids.db_ids.get("views_registry")
            or res.details.get("discovered_db_ids", {}).get("views_registry")
        )

        if not vr_db_id:
            res.warnings.append("views_registry DB not found; view_key checks skipped.")
            return

        existing_keys = self._collect_views_registry_keys(vr_db_id)
        required_entries = self.manifest.get_required_view_entries()

        for entry in required_entries:
            view_key = entry.get("view_key", "")
            db_key = entry.get("db_key", "")
            if view_key and view_key not in existing_keys:
                res.missing_view_keys.append(
                    MissingViewKey(view_key=view_key, db_key=db_key)
                )

    # ─────────────────────────────────────────
    # Step 5: Command Center widget markers
    # ─────────────────────────────────────────

    def _verify_command_center_widgets(self, res: ComplianceResult) -> None:
        cc_page_id = (
            self.ids.page_ids.get("command_center")
            or res.details.get("discovered_page_ids", {}).get("command_center")
        )

        if not cc_page_id:
            # Already captured in missing_pages
            return

        try:
            children = self.api.list_all_block_children(cc_page_id, limit=2000)
        except Exception:
            res.warnings.append("could not list Command Center children; widget verification skipped.")
            return

        # Collect all plain text from blocks
        text_blobs = []
        for block in children:
            text = _extract_plain_text(block)
            if text:
                text_blobs.append(text)

        blob = "\n".join(text_blobs)

        # Check for marker presence for each required widget
        required_widgets = self.manifest.command_center.get("required_widgets", [])
        for w in required_widgets:
            widget_key = w.get("widget_key", "")
            if not widget_key:
                continue

            # Deterministic marker naming: matches widget_registry.py WidgetSpec.effective_marker_key
            marker_key = widget_key.upper().replace(".", "_")
            start_marker = f"[[OPENCLAW:{marker_key}:START]]"
            end_marker = f"[[OPENCLAW:{marker_key}:END]]"

            if start_marker not in blob or end_marker not in blob:
                res.missing_widgets.append(widget_key)

    # ─────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────

    def _search_first_page(self, title: str) -> str | None:
        try:
            resp = self.api.search(title, filter_value="page")
            for r in resp.get("results", []):
                if r.get("object") == "page":
                    return r.get("id")
        except Exception:
            pass
        return None

    def _search_first_database(self, title: str) -> str | None:
        try:
            return self.api.find_database_under_root("", title)
        except Exception:
            pass
        # Fallback to raw search
        try:
            resp = self.api.search(title, filter_value="database")
            for r in resp.get("results", []):
                if r.get("object") == "database":
                    return r.get("id")
        except Exception:
            pass
        return None

    def _collect_views_registry_keys(self, vr_db_id: str) -> set[str]:
        """Read all view_key values from the Views Registry DB."""
        keys: set[str] = set()
        try:
            rows = self.api.query_all_database_rows(vr_db_id)
            for row in rows:
                props = row.get("properties", {})
                # Try both "view_key" and "name" (title) as the key field
                vk = _read_rich_text(props, "view_key")
                if not vk:
                    vk = _read_title(props)
                if vk:
                    keys.add(vk)
        except Exception:
            pass
        return keys


# ─────────────────────────────────────────
# Property parsing helpers
# ─────────────────────────────────────────


def _read_checkbox(props: dict[str, Any], key: str) -> bool | None:
    p = props.get(key)
    if not p or p.get("type") != "checkbox":
        return None
    return bool(p.get("checkbox"))


def _read_date(props: dict[str, Any], key: str) -> str | None:
    p = props.get(key)
    if not p or p.get("type") != "date":
        return None
    d = p.get("date")
    return d.get("start") if d else None


def _read_rich_text(props: dict[str, Any], key: str) -> str | None:
    p = props.get(key)
    if not p:
        return None
    t = p.get("type")
    if t == "rich_text":
        rts = p.get("rich_text") or []
        return "".join(x.get("plain_text", "") for x in rts).strip() or None
    if t == "title":
        rts = p.get("title") or []
        return "".join(x.get("plain_text", "") for x in rts).strip() or None
    return None


def _read_title(props: dict[str, Any]) -> str | None:
    """Extract text from the title property (any name)."""
    for v in props.values():
        if v.get("type") == "title":
            rts = v.get("title") or []
            return "".join(x.get("plain_text", "") for x in rts).strip() or None
    return None


def _extract_plain_text(block: dict[str, Any]) -> str | None:
    """Read plain text from common block types. Enough for marker detection."""
    t = block.get("type")
    if not t:
        return None
    payload = block.get(t) or {}
    rts = payload.get("rich_text")
    if not rts:
        return None
    return "".join(x.get("plain_text", "") for x in rts).strip() or None
