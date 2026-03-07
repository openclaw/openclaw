"""Portal Child-Block Healer — best-UX portal page layout using Notion blocks.

Builds clean, human-friendly Client Portal pages using:
  - H2 headings for sections
  - Dividers between sections
  - Callout blocks (gray_background) for OpenClaw-owned content
  - Icons for visual scanning

Maintains a PortalBlocksRegistry (SQLite) to pin exact block IDs,
so we never "scan and guess" — updates are deterministic.

Replaces ONLY OpenClaw-owned callout blocks; human notes/content
are never touched.

Section order:
  1. start_here  (callout at top, no heading)
  2. trello      (H2: Trello & Requests)
  3. dropbox     (H2: Dropbox & References)
  4. delivery    (H2: Delivery Links)
  5. finance     (H2: Invoices & Payments)
  6. system_notes (H2: System Notes)
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.portal_blocks_registry import (
    PortalBlockRecord,
    PortalBlocksRegistry,
)
from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.portal_child_block_healer")


def _rt(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": {"content": text}}]


def _callout(
    rich_text: list[dict[str, Any]],
    icon_emoji: str | None = None,
) -> dict[str, Any]:
    block: dict[str, Any] = {
        "object": "block",
        "type": "callout",
        "callout": {
            "rich_text": rich_text,
            "color": "gray_background",
        },
    }
    if icon_emoji:
        block["callout"]["icon"] = {"type": "emoji", "emoji": icon_emoji}
    return block


def _heading_2(text: str) -> dict[str, Any]:
    return {
        "object": "block",
        "type": "heading_2",
        "heading_2": {"rich_text": _rt(text)},
    }


def _divider() -> dict[str, Any]:
    return {"object": "block", "type": "divider", "divider": {}}


# Section definitions: (key, heading title, callout icon)
SECTION_ORDER: list[tuple[str, str, str]] = [
    ("start_here", "Start Here", "\U0001f4cc"),       # pin
    ("trello", "Trello & Requests", "\U0001f5c2\ufe0f"),  # card file box
    ("dropbox", "Dropbox & References", "\U0001f4c1"),     # folder
    ("delivery", "Delivery Links", "\u2705"),               # check mark
    ("finance", "Invoices & Payments (Mirror)", "\U0001f4b3"),  # credit card
    ("system_notes", "System Notes", "\u2699\ufe0f"),       # gear
]


class PortalChildBlockHealer:
    """Heals client portal pages as a child-block layout.

    - Creates portal skeleton using headings + dividers + callouts
    - Stores OpenClaw-owned callout block IDs in registry
    - Updates ONLY those callout blocks; never overwrites human blocks
    - Drift heals missing sections by appending missing heading+callout
    - safe_mode simulate first (no writes)
    """

    def __init__(
        self,
        notion: NotionAPI,
        audit: AuditWriter,
        registry: PortalBlocksRegistry,
    ) -> None:
        self.notion = notion
        self.audit = audit
        self.registry = registry

    def heal_portal_page(
        self,
        portal_page_id: str,
        ctx: dict[str, Any],
        correlation_id: str,
        *,
        safe_mode: bool = True,
    ) -> dict[str, Any]:
        """Heal a single client portal page.

        Args:
            portal_page_id: Notion page ID for the client portal.
            ctx: Context dict with keys:
                - client_key, client_name
                - trello_board_url (optional)
                - dropbox_master_url (optional)
                - references_urls (optional list)
            correlation_id: Audit trail ID.
            safe_mode: If True, simulate only (no writes).
        """
        writes = 0
        warnings: list[str] = []

        # 1) Fetch current page children
        children = self.notion.list_all_block_children(portal_page_id, limit=2000)

        # 2) Check if skeleton exists (look for headings)
        existing_headings = self._index_headings(children)

        if not existing_headings:
            # Fresh portal page — create full skeleton
            if safe_mode:
                return {
                    "writes": 0,
                    "warnings": ["portal skeleton missing (safe_mode: would create)"],
                }

            skeleton = self._build_full_skeleton(ctx)
            self.notion.append_block_children(portal_page_id, skeleton)
            writes += 1

            # Re-fetch to get Notion-assigned block IDs, then register
            children = self.notion.list_all_block_children(portal_page_id, limit=2000)
            self._register_from_fresh_layout(portal_page_id, children)

            self.audit.write_event(
                action="notion.portal.skeleton.create",
                target_type="notion_page",
                target_id=portal_page_id,
                details={
                    "correlation_id": correlation_id,
                    "client_key": ctx.get("client_key"),
                },
            )
        else:
            # Partial drift healing — append missing sections
            for section_key, title, icon in SECTION_ORDER:
                if section_key == "start_here":
                    continue  # start_here is a callout at top, no heading
                if title in existing_headings:
                    continue
                if safe_mode:
                    warnings.append(
                        f"missing heading '{title}' (safe_mode: would append section)"
                    )
                    continue

                new_blocks = [
                    _divider(),
                    _heading_2(title),
                    self._owned_callout_block(section_key, ctx),
                ]
                self.notion.append_block_children(portal_page_id, new_blocks)
                writes += 1

            # Ensure "Start Here" callout exists
            self._ensure_start_here_container(
                portal_page_id, children, ctx, safe_mode
            )

            # Register any missing owned blocks
            if not safe_mode:
                children = self.notion.list_all_block_children(
                    portal_page_id, limit=2000
                )
                self._register_missing_owned_blocks(
                    portal_page_id, children, warnings
                )

        # 3) Update OpenClaw-owned callout block content
        for section_key, title, icon in SECTION_ORDER:
            rec = self.registry.get(portal_page_id, section_key)
            if not rec:
                warnings.append(f"registry missing section_key={section_key}")
                continue

            if safe_mode:
                continue

            new_rich_text = self._section_rich_text(section_key, ctx)
            self.notion.update_block(
                rec.container_block_id,
                {"callout": {"rich_text": new_rich_text}},
            )
            writes += 1
            self.audit.write_event(
                action="notion.portal.section.update",
                target_type="notion_block",
                target_id=rec.container_block_id,
                details={
                    "correlation_id": correlation_id,
                    "section_key": section_key,
                    "client_key": ctx.get("client_key"),
                },
            )

        return {"writes": writes, "warnings": warnings}

    def heal_all_clients(
        self,
        client_portals: list[dict[str, Any]],
        correlation_id: str,
        *,
        safe_mode: bool = True,
        max_clients: int = 200,
    ) -> dict[str, Any]:
        """Heal portal pages for multiple clients."""
        writes = 0
        warnings: list[str] = []

        for p in client_portals[:max_clients]:
            portal_page_id = p.get("portal_page_id")
            if not portal_page_id:
                continue
            r = self.heal_portal_page(
                portal_page_id, p, correlation_id, safe_mode=safe_mode
            )
            writes += r.get("writes", 0)
            warnings.extend(r.get("warnings", []))

        return {"writes": writes, "warnings": warnings}

    # ─────────────────────────────────────────
    # Skeleton creation
    # ─────────────────────────────────────────

    def _build_full_skeleton(self, ctx: dict[str, Any]) -> list[dict[str, Any]]:
        """Build complete portal page skeleton blocks."""
        blocks: list[dict[str, Any]] = []

        # Start Here callout at top (no heading)
        blocks.append(
            _callout(self._section_rich_text("start_here", ctx), icon_emoji="\U0001f4cc")
        )
        blocks.append(_divider())

        # Remaining sections: heading + callout + divider
        for section_key, title, icon in SECTION_ORDER:
            if section_key == "start_here":
                continue
            blocks.append(_heading_2(title))
            blocks.append(self._owned_callout_block(section_key, ctx))
            blocks.append(_divider())

        return blocks

    def _owned_callout_block(
        self, section_key: str, ctx: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a callout block for a section with its icon."""
        icon = None
        for k, _, ico in SECTION_ORDER:
            if k == section_key:
                icon = ico
                break
        return _callout(self._section_rich_text(section_key, ctx), icon_emoji=icon)

    # ─────────────────────────────────────────
    # Section content (professional, plain)
    # ─────────────────────────────────────────

    def _section_rich_text(
        self, section_key: str, ctx: dict[str, Any]
    ) -> list[dict[str, Any]]:
        client_key = ctx.get("client_key") or ""
        now = utc_now_iso()

        if section_key == "start_here":
            lines = [
                "Use Trello as the source of truth for requests, status, and delivery.",
                "This portal mirrors key links and status for visibility.",
                "If you cannot find a deliverable, check the Trello card comments "
                "in the relevant stage.",
                "",
                f'{{"client_key":"{client_key}","updated_ts":"{now}",'
                '"block":"start_here"}}',
            ]
            return _rt("\n".join(lines))

        if section_key == "trello":
            board_url = ctx.get("trello_board_url")
            lines = [
                "Requests flow:",
                "Requests \u2192 In Progress \u2192 Needs Review / Feedback "
                "\u2192 Approved / Ready for Delivery \u2192 Published / Delivered",
                "",
            ]
            if board_url:
                lines.append(f"Trello board: {board_url}")
            else:
                lines.append("Trello board: not yet linked.")
            lines.append("")
            lines.append(
                f'{{"client_key":"{client_key}","updated_ts":"{now}",'
                '"block":"trello"}}'
            )
            return _rt("\n".join(lines))

        if section_key == "dropbox":
            dropbox = ctx.get("dropbox_master_url")
            refs = ctx.get("references_urls") or []
            lines: list[str] = []
            if dropbox:
                lines.append(f"Dropbox master folder: {dropbox}")
            else:
                lines.append("Dropbox master folder: not yet linked.")
            if refs:
                lines.append("")
                lines.append("Reference links:")
                for u in refs[:10]:
                    lines.append(f"- {u}")
            lines.append("")
            lines.append(
                f'{{"client_key":"{client_key}","updated_ts":"{now}",'
                '"block":"dropbox"}}'
            )
            return _rt("\n".join(lines))

        if section_key == "delivery":
            lines = [
                "Delivery links are posted on Trello cards and mirrored here by OpenClaw.",
                "If links are missing, check the relevant Trello card comments.",
                "",
                '{"delivery_links":{"drafts":[],"finals":[],"version":1}}',
                "",
                f'{{"client_key":"{client_key}","updated_ts":"{now}",'
                '"block":"delivery"}}',
            ]
            return _rt("\n".join(lines))

        if section_key == "finance":
            lines = [
                "Visibility-only mirror.",
                "Stripe is the revenue source of truth. "
                "QuickBooks is the accounting source of truth.",
                "",
                f'{{"client_key":"{client_key}","updated_ts":"{now}",'
                '"block":"finance"}}',
            ]
            return _rt("\n".join(lines))

        if section_key == "system_notes":
            lines = [
                "Do not edit database schemas manually. OpenClaw owns schema changes.",
                "If a section is missing, OpenClaw will restore it during reconcile.",
                "",
                f'{{"client_key":"{client_key}","updated_ts":"{now}",'
                '"block":"system_notes"}}',
            ]
            return _rt("\n".join(lines))

        return _rt(f"(unhandled section_key={section_key})")

    # ─────────────────────────────────────────
    # Registry operations
    # ─────────────────────────────────────────

    def _index_headings(
        self, children: list[dict[str, Any]]
    ) -> dict[str, str]:
        """Map heading text -> block ID for heading_2 blocks."""
        out: dict[str, str] = {}
        for b in children:
            if b.get("type") != "heading_2":
                continue
            rt = b.get("heading_2", {}).get("rich_text") or []
            text = "".join(x.get("plain_text", "") for x in rt)
            if text:
                out[text] = b.get("id", "")
        return out

    def _ensure_start_here_container(
        self,
        portal_page_id: str,
        children: list[dict[str, Any]],
        ctx: dict[str, Any],
        safe_mode: bool,
    ) -> None:
        """Ensure start_here callout is registered."""
        rec = self.registry.get(portal_page_id, "start_here")
        if rec:
            return

        # Try to find first callout on page
        first_callout = next(
            (b for b in children if b.get("type") == "callout"), None
        )

        if first_callout:
            self.registry.upsert(
                PortalBlockRecord(
                    portal_page_id=portal_page_id,
                    section_key="start_here",
                    container_block_id=first_callout["id"],
                )
            )
            return

        if safe_mode:
            return

        # Append start_here callout + divider
        self.notion.append_block_children(
            portal_page_id,
            [
                _callout(
                    self._section_rich_text("start_here", ctx),
                    icon_emoji="\U0001f4cc",
                ),
                _divider(),
            ],
        )
        # Re-fetch and register
        refreshed = self.notion.list_all_block_children(portal_page_id, limit=2000)
        for b in refreshed:
            if b.get("type") == "callout":
                self.registry.upsert(
                    PortalBlockRecord(
                        portal_page_id=portal_page_id,
                        section_key="start_here",
                        container_block_id=b["id"],
                    )
                )
                return

    def _register_from_fresh_layout(
        self, portal_page_id: str, children: list[dict[str, Any]]
    ) -> None:
        """Register all owned blocks after creating a fresh skeleton."""
        # start_here: first callout
        first_callout = next(
            (b for b in children if b.get("type") == "callout"), None
        )
        if first_callout:
            self.registry.upsert(
                PortalBlockRecord(
                    portal_page_id, "start_here", first_callout["id"]
                )
            )

        # Other sections: heading -> next callout
        heading_ids = self._index_headings(children)
        for section_key, title, _ in SECTION_ORDER:
            if section_key == "start_here":
                continue
            hid = heading_ids.get(title)
            if not hid:
                continue
            container = self._find_next_callout_after(children, hid)
            if container:
                self.registry.upsert(
                    PortalBlockRecord(
                        portal_page_id,
                        section_key,
                        container["id"],
                        header_block_id=hid,
                    )
                )

    def _register_missing_owned_blocks(
        self,
        portal_page_id: str,
        children: list[dict[str, Any]],
        warnings: list[str],
    ) -> None:
        """Register any owned blocks not yet in the registry."""
        heading_ids = self._index_headings(children)
        for section_key, title, _ in SECTION_ORDER:
            if self.registry.get(portal_page_id, section_key):
                continue
            if section_key == "start_here":
                continue
            hid = heading_ids.get(title)
            if not hid:
                continue
            container = self._find_next_callout_after(children, hid)
            if container:
                self.registry.upsert(
                    PortalBlockRecord(
                        portal_page_id,
                        section_key,
                        container["id"],
                        header_block_id=hid,
                    )
                )
            else:
                warnings.append(
                    f"could not find callout container after heading '{title}'"
                )

    def _find_next_callout_after(
        self, children: list[dict[str, Any]], heading_block_id: str
    ) -> dict[str, Any] | None:
        """Find the first callout block after a heading block."""
        seen = False
        for b in children:
            if b.get("id") == heading_block_id:
                seen = True
                continue
            if not seen:
                continue
            if b.get("type") == "callout":
                return b
            # Stop if we hit another heading before finding a callout
            if b.get("type") == "heading_2":
                return None
        return None
