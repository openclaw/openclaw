"""Concrete Notion REST client with retry, rate-limiting, and full CRUD.

Built on top of NotionClient (httpx + tenacity). Provides:
- Jittered exponential backoff with Retry-After support for 429
- Full read/write helpers (pages, databases, blocks, search)
- System table upserts (settings, views registry)
- Property schema builders from manifest spec
"""
from __future__ import annotations

import random
import time
from typing import Any

from packages.agencyu.notion.client import NotionClient
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.notion_api")

# Maximum retries for transient errors
MAX_RETRIES = 6
# Backoff cap in seconds
MAX_BACKOFF_S = 30.0


def _exp_backoff(attempt: int) -> float:
    """Jittered exponential backoff."""
    base = min(2 ** attempt, MAX_BACKOFF_S)
    return base * (0.3 + random.random() * 0.7)


class NotionAPI:
    """Higher-level Notion API client with full CRUD and retry logic.

    Provides semantic operations used by:
    - Compliance verifier (read-only schema checks)
    - Drift healer (write: create databases, add properties, add options)
    - Portal compliance (read/write blocks)
    - System bootstrap (upsert settings, views registry rows)
    """

    def __init__(self, client: NotionClient | None = None) -> None:
        self.client = client or NotionClient()

    # ─────────────────────────────────────────
    # Core HTTP with retry/backoff
    # ─────────────────────────────────────────

    def _request(
        self, method: str, path: str, json_body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Execute an HTTP request with retry and rate-limit awareness."""
        url = f"{self.client.base_url}{path}"
        for attempt in range(1, MAX_RETRIES + 1):
            self.client._limiter.acquire()
            try:
                if method == "GET":
                    resp = self.client._client.get(url, headers=self.client._headers())
                elif method == "POST":
                    resp = self.client._client.post(url, json=json_body or {}, headers=self.client._headers())
                elif method == "PATCH":
                    resp = self.client._client.patch(url, json=json_body or {}, headers=self.client._headers())
                elif method == "DELETE":
                    resp = self.client._client.delete(url, headers=self.client._headers())
                else:
                    raise ValueError(f"Unsupported method: {method}")

                if resp.status_code in (200, 201):
                    return resp.json()

                # 429 rate limit
                if resp.status_code == 429:
                    retry_after = resp.headers.get("Retry-After")
                    sleep_s = float(retry_after) if retry_after else _exp_backoff(attempt)
                    time.sleep(sleep_s)
                    continue

                # Transient 5xx
                if 500 <= resp.status_code <= 599:
                    time.sleep(_exp_backoff(attempt))
                    continue

                # Non-retryable error
                raise RuntimeError(f"Notion API error {resp.status_code}: {resp.text}")

            except (ConnectionError, TimeoutError):
                time.sleep(_exp_backoff(attempt))
                continue

        raise RuntimeError(f"Notion API request failed after {MAX_RETRIES} retries: {method} {path}")

    # ─────────────────────────────────────────
    # Read helpers
    # ─────────────────────────────────────────

    def can_read_page(self, page_id: str) -> bool:
        """Check if the integration can read a page."""
        try:
            self._request("GET", f"/pages/{page_id}")
            return True
        except Exception:
            return False

    def get_page(self, page_id: str) -> dict[str, Any]:
        """Fetch a page by ID."""
        return self._request("GET", f"/pages/{page_id}")

    def retrieve_block(self, block_id: str) -> dict[str, Any]:
        """Fetch a single block by ID."""
        return self._request("GET", f"/blocks/{block_id}")

    def delete_block(self, block_id: str) -> dict[str, Any]:
        """Archive (soft-delete) a block."""
        return self._request("DELETE", f"/blocks/{block_id}")

    def update_block(self, block_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Update a block's content (e.g. callout rich_text, toggle text)."""
        return self._request("PATCH", f"/blocks/{block_id}", payload)

    def get_block_children(
        self, block_id: str, start_cursor: str | None = None, page_size: int = 100
    ) -> dict[str, Any]:
        """Fetch child blocks of a block/page."""
        qs = f"?page_size={page_size}"
        if start_cursor:
            qs += f"&start_cursor={start_cursor}"
        return self._request("GET", f"/blocks/{block_id}/children{qs}")

    def list_all_block_children(
        self, block_id: str, limit: int = 2000
    ) -> list[dict[str, Any]]:
        """Paginate through all child blocks, up to limit."""
        out: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = self.get_block_children(block_id, start_cursor=cursor)
            out.extend(page.get("results", []))
            if len(out) >= limit:
                return out[:limit]
            if not page.get("has_more"):
                break
            cursor = page.get("next_cursor")
        return out

    def search(
        self, query: str, filter_value: str = "database", start_cursor: str | None = None
    ) -> dict[str, Any]:
        """Search Notion workspace."""
        payload: dict[str, Any] = {
            "query": query,
            "filter": {"property": "object", "value": filter_value},
        }
        if start_cursor:
            payload["start_cursor"] = start_cursor
        return self._request("POST", "/search", payload)

    def find_database_under_root(
        self, root_page_id: str, expected_title: str
    ) -> str | None:
        """Search for a database by title. Returns database ID or None."""
        cursor = None
        while True:
            res = self.search(expected_title, filter_value="database", start_cursor=cursor)
            for item in res.get("results", []):
                title = self._db_title(item)
                if title.strip().lower() == expected_title.strip().lower():
                    return item.get("id")
            if not res.get("has_more"):
                break
            cursor = res.get("next_cursor")
        return None

    def get_database(self, database_id: str) -> dict[str, Any]:
        """Fetch full database schema with normalized properties."""
        data = self._request("GET", f"/databases/{database_id}")

        # Normalize properties into a simpler format
        properties: dict[str, Any] = {}
        for prop_name, prop_config in data.get("properties", {}).items():
            prop_type = prop_config.get("type", "unknown")
            normalized: dict[str, Any] = {"type": prop_type}

            # Extract select/multi_select options
            if prop_type in ("select", "multi_select"):
                options_data = prop_config.get(prop_type, {}).get("options", [])
                normalized["options"] = [o.get("name", "") for o in options_data]

            # Extract relation target
            if prop_type == "relation":
                relation_config = prop_config.get("relation", {})
                normalized["target_db_id"] = relation_config.get("database_id")

            properties[prop_name] = normalized

        return {"properties": properties, "id": database_id}

    def query_database(
        self,
        database_id: str,
        filter_obj: dict[str, Any] | None = None,
        sorts: list[dict[str, Any]] | None = None,
        start_cursor: str | None = None,
        page_size: int = 100,
    ) -> dict[str, Any]:
        """Query a database with optional filter/sort/pagination."""
        payload: dict[str, Any] = {"page_size": page_size}
        if filter_obj:
            payload["filter"] = filter_obj
        if sorts:
            payload["sorts"] = sorts
        if start_cursor:
            payload["start_cursor"] = start_cursor
        return self._request("POST", f"/databases/{database_id}/query", payload)

    def query_all_database_rows(self, database_id: str) -> list[dict[str, Any]]:
        """Paginate through all rows of a database."""
        rows: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = self.query_database(database_id, start_cursor=cursor)
            rows.extend(page.get("results", []))
            if not page.get("has_more"):
                break
            cursor = page.get("next_cursor")
        return rows

    # ─────────────────────────────────────────
    # Write helpers
    # ─────────────────────────────────────────

    def create_database(
        self, parent_page_id: str, payload: dict[str, Any]
    ) -> str:
        """Create a new database under a parent page. Returns new database ID."""
        body: dict[str, Any] = {
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "title": [{"type": "text", "text": {"content": payload["title"]}}],
            "properties": payload["properties"],
        }
        if payload.get("description"):
            body["description"] = [{"type": "text", "text": {"content": payload["description"]}}]
        res = self._request("POST", "/databases", body)
        return res["id"]

    def update_database(self, database_id: str, payload: dict[str, Any]) -> None:
        """Patch a database (properties, title, etc.)."""
        self._request("PATCH", f"/databases/{database_id}", payload)

    def append_select_options(
        self, database_id: str, payload: dict[str, Any]
    ) -> None:
        """Merge new select/multi_select options into an existing property.

        Fetches current options, deduplicates, then patches.
        """
        prop_name = payload["property_name"]
        new_options = payload.get("options", [])
        prop_type = payload.get("type", "select")

        db = self.get_database(database_id)
        prop = db["properties"].get(prop_name)
        if not prop:
            raise RuntimeError(f"Property not found to append options: {prop_name}")

        existing_opts = self.extract_select_options(prop)
        merged = existing_opts[:]
        for opt in new_options:
            if opt not in merged:
                merged.append(opt)

        patch: dict[str, Any] = {
            "properties": {
                prop_name: {
                    prop_type: {"options": [{"name": x} for x in merged]}
                }
            }
        }
        self.update_database(database_id, patch)

    def create_page(
        self, parent: dict[str, Any], properties: dict[str, Any]
    ) -> str:
        """Create a new page. Returns page ID."""
        body = {"parent": parent, "properties": properties}
        res = self._request("POST", "/pages", body)
        return res["id"]

    def update_page(self, page_id: str, properties: dict[str, Any]) -> None:
        """Update page properties."""
        self._request("PATCH", f"/pages/{page_id}", {"properties": properties})

    def append_block_children(
        self, block_id: str, children: list[dict[str, Any]]
    ) -> None:
        """Append child blocks to a block/page."""
        self._request("PATCH", f"/blocks/{block_id}/children", {"children": children})

    # ─────────────────────────────────────────
    # System table upserts (idempotent)
    # ─────────────────────────────────────────

    def upsert_settings_record(
        self, system_settings_db_id: str, payload: dict[str, Any]
    ) -> None:
        """Upsert the 'Primary' settings row in the System Settings DB."""
        rows = self.query_all_database_rows(system_settings_db_id)
        primary = None
        for r in rows:
            title = self._page_title(r)
            if title.strip().lower() == "primary":
                primary = r
                break

        props = self._props_system_settings(payload)

        if primary:
            self.update_page(primary["id"], props)
        else:
            parent = {"type": "database_id", "database_id": system_settings_db_id}
            props["Name"] = {"title": [{"text": {"content": "Primary"}}]}
            self.create_page(parent, props)

    def update_system_settings(
        self, system_settings_db_id: str, payload: dict[str, Any]
    ) -> None:
        """Alias for upsert_settings_record."""
        self.upsert_settings_record(system_settings_db_id, payload)

    def upsert_views_registry_row(
        self, views_registry_db_id: str, payload: dict[str, Any]
    ) -> None:
        """Upsert a views registry row keyed by (database_key, view_name)."""
        db_key = payload["database_key"]
        view_name = payload["view_name"]

        rows = self.query_all_database_rows(views_registry_db_id)
        existing = None
        for r in rows:
            if (
                self._page_title(r).strip() == view_name
                and self._select_value(r, "Database Key") == db_key
            ):
                existing = r
                break

        props: dict[str, Any] = {
            "Database Key": {"select": {"name": db_key}},
            "Required": {"checkbox": bool(payload.get("required", True))},
            "Status": {"select": {"name": payload.get("status", "unknown")}},
        }
        if payload.get("last_verified_at"):
            props["Last Verified At"] = {"date": {"start": payload["last_verified_at"]}}
        if payload.get("notes"):
            props["Notes"] = {"rich_text": [{"text": {"content": payload["notes"]}}]}

        if existing:
            self.update_page(existing["id"], props)
        else:
            parent = {"type": "database_id", "database_id": views_registry_db_id}
            props["Name"] = {"title": [{"text": {"content": view_name}}]}
            self.create_page(parent, props)

    # ─────────────────────────────────────────
    # Property schema builders
    # ─────────────────────────────────────────

    def build_property_schema(self, prop_spec: dict[str, Any]) -> dict[str, Any]:
        """Convert a manifest property spec to Notion API property config."""
        t = prop_spec["type"]
        configs: dict[str, dict[str, Any]] = {
            "title": {"title": {}},
            "rich_text": {"rich_text": {}},
            "number": {"number": {"format": "number"}},
            "checkbox": {"checkbox": {}},
            "date": {"date": {}},
            "url": {"url": {}},
            "email": {"email": {}},
            "phone_number": {"phone_number": {}},
            "people": {"people": {}},
        }
        if t in configs:
            return configs[t]
        if t == "select":
            opts = prop_spec.get("options", [])
            return {"select": {"options": [{"name": o} for o in opts]}}
        if t == "multi_select":
            opts = prop_spec.get("options", [])
            return {"multi_select": {"options": [{"name": o} for o in opts]}}
        if t == "relation":
            return {
                "relation": {
                    "database_id": prop_spec.get("target_db_id_placeholder", ""),
                    "single_property": {},
                }
            }
        raise RuntimeError(f"Unsupported property type: {t}")

    def extract_select_options(self, prop: dict[str, Any]) -> list[str]:
        """Extract option names from a normalized property dict."""
        return prop.get("options", [])

    def extract_relation_target_db_id(self, prop: dict[str, Any]) -> str | None:
        """Extract the target database ID from a normalized relation property."""
        return prop.get("target_db_id")

    def supports_view_enumeration(self) -> bool:
        """Notion API has limited view support — use Views Registry instead."""
        return False

    def list_database_views(self, database_id: str) -> list[str]:
        """List view names. Limited by Notion API — use Views Registry."""
        return []

    # ─────────────────────────────────────────
    # Internal parsing helpers
    # ─────────────────────────────────────────

    def _db_title(self, db_obj: dict[str, Any]) -> str:
        title = db_obj.get("title", [])
        if not title:
            return ""
        return "".join(t.get("plain_text", "") for t in title)

    def _page_title(self, page_obj: dict[str, Any]) -> str:
        props = page_obj.get("properties", {})
        name = props.get("Name") or props.get("name") or props.get("Title")
        if not name:
            for v in props.values():
                if v.get("type") == "title":
                    name = v
                    break
        if not name:
            return ""
        return "".join(t.get("plain_text", "") for t in name.get("title", []))

    def _select_value(self, page_obj: dict[str, Any], prop_name: str) -> str | None:
        props = page_obj.get("properties", {})
        p = props.get(prop_name)
        if not p:
            return None
        if p.get("type") == "select" and p.get("select"):
            return p["select"]["name"]
        return None

    def _props_system_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Build Notion properties dict for system settings page."""
        props: dict[str, Any] = {}
        mapping = {
            "template_version": "Template Version",
            "os_version": "OS Version",
            "notion_root_page_id": "Notion Root Page ID",
            "manifest_hash": "Manifest Hash",
        }
        for key, notion_name in mapping.items():
            if key in payload and payload[key]:
                props[notion_name] = {"rich_text": [{"text": {"content": str(payload[key])}}]}

        if "write_lock" in payload:
            props["Write Lock"] = {"checkbox": bool(payload["write_lock"])}
        if "last_verified_at" in payload and payload["last_verified_at"]:
            props["Last Verified At"] = {"date": {"start": payload["last_verified_at"]}}

        return props
