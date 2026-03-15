"""
bodhi_vault.siyuan_sync — Fire-and-forget sync from vault nodes to SiYuan.

Disabled automatically when SIYUAN_API_TOKEN is unset.
Never raises — vault writes succeed regardless of SiYuan state.

Environment variables:
    SIYUAN_API_URL   — Base URL of SiYuan instance.
                       Default: http://localhost:6806
    SIYUAN_API_TOKEN — Bearer token for SiYuan API authentication.
                       If unset, all sync functions are silent no-ops.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DEFAULT_SIYUAN_URL = "http://localhost:6806"

DOMAIN_NOTEBOOK: dict[str | None, str] = {
    # Bo domains — wellness agents
    "wellness": "OpenBodhi-Wellness",
    "fitness": "OpenBodhi-Fitness",
    "health": "OpenBodhi-Health",
    "mental-health": "OpenBodhi-Mental",
    "cognitive": "OpenBodhi-Cognitive",
    # Qenjin domains — business operations
    "business": "Qenjin-Business",
    # Moonman domains — trading
    "trading": "Trader-Log",
}
PEOPLE_NOTEBOOK = "OpenBodhi-People"
DIGESTS_NOTEBOOK = "OpenBodhi-Digests"

# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class SiYuanClient:
    """
    Thin synchronous wrapper around the SiYuan HTTP API.

    All public methods return None on any error — sync is best-effort.
    """

    def __init__(self, base_url: str, token: str) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Token {token}", "Content-Type": "application/json"}
        # Notebook name → id cache, populated lazily
        self._notebook_ids: dict[str, str] = {}

    # -----------------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------------

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any] | None:
        """POST to SiYuan API, return parsed JSON data block or None on failure."""
        try:
            resp = httpx.post(
                f"{self._base}{path}",
                json=body,
                headers=self._headers,
                timeout=10,
            )
            resp.raise_for_status()
            payload = resp.json()
            if payload.get("code", 0) != 0:
                log.debug("siyuan %s non-zero code: %s", path, payload.get("msg"))
                return None
            return payload.get("data")
        except Exception as exc:
            log.debug("siyuan %s failed: %s", path, exc)
            return None

    def _ensure_notebook(self, name: str) -> str | None:
        """Return notebook id for name, creating it if missing. Cached."""
        if name in self._notebook_ids:
            return self._notebook_ids[name]

        data = self._post("/api/notebook/lsNotebooks", {})
        if data is not None:
            for nb in data.get("notebooks", []):
                self._notebook_ids[nb["name"]] = nb["id"]

        if name not in self._notebook_ids:
            created = self._post("/api/notebook/createNotebook", {"name": name})
            if created and created.get("notebook", {}).get("id"):
                nb_id = created["notebook"]["id"]
                self._notebook_ids[name] = nb_id
            else:
                return None

        return self._notebook_ids.get(name)

    def _set_attrs(self, block_id: str, node: dict[str, Any]) -> None:
        """Attach custom-bodhi-* IAL attributes to a SiYuan block."""
        attrs: dict[str, str] = {
            "custom-bodhi-id": node.get("id", ""),
            "custom-bodhi-type": node.get("type", ""),
            "custom-bodhi-energy": str(node.get("energy_level", "")),
            "custom-bodhi-domain": node.get("domain", ""),
            "custom-bodhi-tags": ",".join(node.get("tags", [])),
            "custom-bodhi-created-at": node.get("created_at", ""),
        }
        # Strip empty values — SiYuan IAL rejects blank attr values
        attrs = {k: v for k, v in attrs.items() if v}
        if attrs:
            self._post("/api/attr/setBlockAttrs", {"id": block_id, "attrs": attrs})

    @staticmethod
    def _validate_notebook_id(notebook_id: str) -> bool:
        """SiYuan notebook IDs are alphanumeric + hyphens, typically 20 chars."""
        return bool(re.fullmatch(r"[A-Za-z0-9\-]{1,64}", notebook_id))

    def _find_person_doc(self, notebook_id: str, person_name: str) -> str | None:
        """Return the block id of an existing person doc, or None."""
        if not self._validate_notebook_id(notebook_id):
            log.debug("siyuan: skipping person doc lookup — unexpected notebook_id format")
            return None
        safe_name = person_name.replace("'", "''")
        data = self._post(
            "/api/query/sql",
            {"stmt": f"SELECT id FROM blocks WHERE type='d' AND content='{safe_name}' AND box='{notebook_id}' LIMIT 1"},
        )
        if data and isinstance(data, list) and data[0].get("id"):
            return data[0]["id"]
        return None

    # -----------------------------------------------------------------------
    # Public sync methods
    # -----------------------------------------------------------------------

    def sync_node(self, node: dict[str, Any]) -> str | None:
        """
        Create a SiYuan document from a vault node.

        Routes to the appropriate domain notebook. Returns the created
        block id, or None on failure.
        """
        domain = node.get("domain")
        notebook_name = DOMAIN_NOTEBOOK.get(domain, DIGESTS_NOTEBOOK)
        notebook_id = self._ensure_notebook(notebook_name)
        if not notebook_id:
            return None

        year_month = node.get("created_at", "")[:7] or "undated"
        doc_path = f"/{year_month}/{node['id']}"
        markdown = _node_to_markdown(node)

        data = self._post(
            "/api/filetree/createDocWithMd",
            {"notebook": notebook_id, "path": doc_path, "markdown": markdown},
        )
        if not data:
            return None

        block_id = data if isinstance(data, str) else None
        if block_id:
            self._set_attrs(block_id, node)
        return block_id

    def sync_person_note(self, node: dict[str, Any]) -> None:
        """
        Upsert person docs in the People notebook.

        One doc per person (keyed by name). Each encounter appends a new
        dated interaction block. Creates the doc if it doesn't exist yet.
        """
        people: list[str] = node.get("people", [])
        if not people:
            return

        notebook_id = self._ensure_notebook(PEOPLE_NOTEBOOK)
        if not notebook_id:
            return

        interaction_md = _interaction_block(node)

        for person in people:
            existing_id = self._find_person_doc(notebook_id, person)
            if existing_id:
                # Append interaction to existing person doc
                self._post(
                    "/api/block/appendBlock",
                    {"data": interaction_md, "parentID": existing_id, "dataType": "markdown"},
                )
            else:
                # Create new person doc seeded with this interaction
                doc_path = f"/{person}"
                init_md = f"# {person}\n\n{interaction_md}"
                data = self._post(
                    "/api/filetree/createDocWithMd",
                    {"notebook": notebook_id, "path": doc_path, "markdown": init_md},
                )
                if data and isinstance(data, str):
                    # Tag the doc with the person's name for future queries
                    self._post(
                        "/api/attr/setBlockAttrs",
                        {"id": data, "attrs": {"custom-bodhi-person": person}},
                    )


# ---------------------------------------------------------------------------
# Markdown formatters
# ---------------------------------------------------------------------------


def _node_to_markdown(node: dict[str, Any]) -> str:
    """Convert a vault node to a SiYuan-compatible Markdown document."""
    lines: list[str] = []
    # Title: first 80 chars of content, stripped
    title = node.get("content", "")[:80].strip().replace("\n", " ")
    lines.append(f"# {title}")
    lines.append("")

    content = node.get("content", "")
    if content:
        lines.append(content)
        lines.append("")

    # Metadata block
    meta_parts = []
    if node.get("type"):
        meta_parts.append(f"**Type:** {node['type']}")
    if node.get("energy_level"):
        meta_parts.append(f"**Energy:** {node['energy_level']}/5")
    if node.get("domain"):
        meta_parts.append(f"**Domain:** {node['domain']}")
    if node.get("tags"):
        meta_parts.append(f"**Tags:** {', '.join(node['tags'])}")
    if node.get("people"):
        meta_parts.append(f"**People:** {', '.join(node['people'])}")
    if node.get("social_context"):
        meta_parts.append(f"**Social:** {node['social_context']}")
    if node.get("created_at"):
        meta_parts.append(f"**Captured:** {node['created_at'][:19].replace('T', ' ')}")

    if meta_parts:
        lines.extend(meta_parts)
        lines.append("")

    return "\n".join(lines)


def _interaction_block(node: dict[str, Any]) -> str:
    """Format one interaction block for appending to a person doc."""
    ts = node.get("created_at", "")[:19].replace("T", " ")
    domain = node.get("domain", "")
    content = node.get("content", "").strip()
    tags = ", ".join(node.get("tags", []))
    return f"**{ts}** · {domain}\n\n{content}\n\n*tags: {tags}*\n\n---"


# ---------------------------------------------------------------------------
# Module-level entry point (fire-and-forget)
# ---------------------------------------------------------------------------


_client: SiYuanClient | None = None


def _get_client() -> SiYuanClient | None:
    """Return a cached SiYuanClient, or None when token is absent."""
    global _client  # noqa: PLW0603
    token = os.environ.get("SIYUAN_API_TOKEN", "").strip()
    if not token:
        return None
    # Rebuild when credentials or URL change at runtime
    base_url = os.environ.get("SIYUAN_API_URL", _DEFAULT_SIYUAN_URL)
    if _client is None or _client._base != base_url.rstrip("/"):
        _client = SiYuanClient(base_url, token)
    return _client


def sync_to_siyuan(node: dict[str, Any]) -> None:
    """
    Sync a vault node to SiYuan. Safe to call unconditionally — silently
    disabled when SIYUAN_API_TOKEN is not set in the environment.

    Never raises. Vault writes are independent of SiYuan availability.
    """
    client = _get_client()
    if client is None:
        return

    try:
        client.sync_node(node)
        if node.get("people"):
            client.sync_person_note(node)
    except Exception as exc:  # noqa: BLE001
        # Best-effort — never propagate to caller
        log.debug("siyuan sync skipped: %s", exc)
