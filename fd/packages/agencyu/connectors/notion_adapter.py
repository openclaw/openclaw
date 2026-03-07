from __future__ import annotations

from typing import Any

from packages.agencyu.notion.client import NotionClient
from packages.common.logging import get_logger

log = get_logger("agencyu.connectors.notion_adapter")


class NotionWorkspaceAdapter:
    """Adapter wrapping NotionClient with workspace discovery methods
    needed by the compliance validator.
    """

    def __init__(self, client: NotionClient) -> None:
        self.client = client

    def get_page(self, page_id: str) -> dict[str, Any]:
        """Get a page's metadata including title."""
        self.client._limiter.acquire()
        resp = self.client._client.get(
            f"{self.client.base_url}/pages/{page_id}",
            headers=self.client._headers(),
        )
        resp.raise_for_status()
        data = resp.json()
        title = ""
        for prop in data.get("properties", {}).values():
            if prop.get("type") == "title":
                title_parts = prop.get("title", [])
                title = "".join(t.get("plain_text", "") for t in title_parts)
                break
        return {"id": page_id, "title": title, "raw": data}

    def list_child_pages(self, page_id: str) -> list[dict[str, Any]]:
        """List child pages/databases under a page."""
        self.client._limiter.acquire()
        resp = self.client._client.get(
            f"{self.client.base_url}/blocks/{page_id}/children",
            headers=self.client._headers(),
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
        children = []
        for block in results:
            if block.get("type") == "child_page":
                children.append({
                    "id": block["id"],
                    "title": block.get("child_page", {}).get("title", ""),
                })
            elif block.get("type") == "child_database":
                children.append({
                    "id": block["id"],
                    "title": block.get("child_database", {}).get("title", ""),
                })
        return children

    def discover_databases_under_root(self, root_page_id: str) -> list[dict[str, Any]]:
        """Discover databases and their schemas under the root page."""
        children = self.list_child_pages(root_page_id)
        databases = []
        for child in children:
            try:
                self.client._limiter.acquire()
                resp = self.client._client.get(
                    f"{self.client.base_url}/databases/{child['id']}",
                    headers=self.client._headers(),
                )
                if resp.status_code != 200:
                    continue
                db_data = resp.json()
                title_parts = db_data.get("title", [])
                name = "".join(t.get("plain_text", "") for t in title_parts)

                # Extract schema
                schema: dict[str, Any] = {}
                for prop_name, prop_data in db_data.get("properties", {}).items():
                    prop_info: dict[str, Any] = {"type": prop_data.get("type", "")}
                    if prop_data.get("type") in ("select", "multi_select"):
                        prop_info["options"] = [
                            o.get("name", "") for o in prop_data.get(prop_data["type"], {}).get("options", [])
                        ]
                    if prop_data.get("type") == "status":
                        groups = prop_data.get("status", {}).get("groups", [])
                        prop_info["options"] = []
                        for g in groups:
                            for o in g.get("options", []):
                                prop_info["options"].append(o.get("name", ""))
                    if prop_data.get("type") == "relation":
                        prop_info["target_db_id"] = prop_data.get("relation", {}).get("database_id")
                    schema[prop_name] = prop_info

                databases.append({"id": child["id"], "name": name, "schema": schema})
            except Exception:
                log.warning("database_discovery_failed", extra={"child_id": child["id"]})
                continue
        return databases

    def list_database_views(self, database_id: str) -> list[dict[str, Any]]:
        """List views for a database. Notion API has limited view support."""
        # Notion API does not expose views directly via REST.
        # Return empty list; compliance validator treats missing views as warnings.
        return []
