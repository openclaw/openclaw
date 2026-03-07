"""Client portal compliance verifier and healer.

Verifies that client portal pages in Notion contain all required sections
and system-managed marker blocks. Healer can:
- Append missing section headings
- Insert replace-between-markers blocks for system-managed content
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from packages.common.clock import utc_now_iso
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.portal_compliance")

# Required sections that must appear in every client portal page
REQUIRED_HEADINGS = [
    "Overview",
    "Onboarding Checklist",
    "Brand Assets",
    "Active Projects",
    "Deliverables",
    "Meetings",
    "Financial Summary",
]

# Replace-between-markers blocks (system-managed sections)
MARKERS = {
    "SYSTEM_NOTES": ("<!-- BEGIN: SYSTEM_NOTES -->", "<!-- END: SYSTEM_NOTES -->"),
    "LINKED_VIEWS": ("<!-- BEGIN: LINKED_VIEWS -->", "<!-- END: LINKED_VIEWS -->"),
}


@dataclass
class PortalIssue:
    """A single portal compliance issue."""

    client_id: str
    section: str
    issue_type: str  # missing_heading / missing_marker_block / access_error
    details: str
    healable: bool = True


@dataclass
class PortalComplianceResult:
    """Result of a client portal compliance check."""

    client_id: str
    portal_page_id: str | None
    compliant: bool
    issues: list[PortalIssue] = field(default_factory=list)
    missing_sections: list[str] = field(default_factory=list)
    missing_markers: list[str] = field(default_factory=list)


@dataclass
class PortalHealResult:
    """Result of healing a client portal."""

    client_id: str
    simulate: bool
    healed_sections: list[str] = field(default_factory=list)
    healed_markers: list[str] = field(default_factory=list)
    skipped_sections: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class PortalComplianceVerifier:
    """Verifies and heals client portal pages in Notion.

    Strategy:
    - Detect required headings
    - Ensure system-managed marker blocks exist
    - Healer inserts missing headings and marker blocks at bottom (safe)
    - Future: replace-between-markers for system-managed content updates
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        notion_client: Any | None = None,
        required_headings: list[str] | None = None,
        markers: dict[str, tuple[str, str]] | None = None,
    ) -> None:
        self.conn = conn
        self.notion = notion_client
        self.required_headings = required_headings if required_headings is not None else REQUIRED_HEADINGS
        self.markers = markers if markers is not None else MARKERS

    def verify_portal(
        self,
        client_id: str,
        portal_page_id: str | None = None,
        page_content: list[dict[str, Any]] | None = None,
    ) -> PortalComplianceResult:
        """Verify a client portal page has all required sections and markers.

        Args:
            client_id: The client identifier.
            portal_page_id: Notion page ID (used for API fetch if page_content not provided).
            page_content: Pre-fetched page blocks (for offline/testing use).

        Returns:
            PortalComplianceResult with issues, missing sections, and missing markers.
        """
        if page_content is None and portal_page_id and self.notion:
            page_content = self._fetch_page_blocks(portal_page_id)

        if page_content is None:
            page_content = []

        # Extract heading text from blocks
        found_headings = self._extract_headings(page_content)

        # Concatenate all plain text for marker detection
        text_blob = self._concat_plain_text(page_content)

        issues: list[PortalIssue] = []
        missing_sections: list[str] = []
        missing_markers: list[str] = []

        # Check required headings
        for section in self.required_headings:
            if not any(section.lower() == h.lower() for h in found_headings):
                missing_sections.append(section)
                issues.append(PortalIssue(
                    client_id=client_id,
                    section=section,
                    issue_type="missing_heading",
                    details=f"Missing heading: {section}",
                ))

        # Check marker blocks
        for key, (begin, end) in self.markers.items():
            if begin not in text_blob or end not in text_blob:
                missing_markers.append(key)
                issues.append(PortalIssue(
                    client_id=client_id,
                    section=key,
                    issue_type="missing_marker_block",
                    details=f"Missing marker block: {key}",
                ))

        compliant = len(issues) == 0
        result = PortalComplianceResult(
            client_id=client_id,
            portal_page_id=portal_page_id,
            compliant=compliant,
            issues=issues,
            missing_sections=missing_sections,
            missing_markers=missing_markers,
        )

        # Persist to portal_compliance table
        self._persist_result(result)

        return result

    def heal_portal(
        self,
        client_id: str,
        portal_page_id: str | None = None,
        simulate: bool = True,
        missing_sections: list[str] | None = None,
        missing_markers: list[str] | None = None,
    ) -> PortalHealResult:
        """Heal a client portal by appending missing headings and marker blocks.

        Args:
            client_id: The client identifier.
            portal_page_id: Notion page ID to append blocks to.
            simulate: If True, only report what would be done (no mutations).
            missing_sections: Sections to heal. If None, runs verify first.
            missing_markers: Marker blocks to heal. If None, runs verify first.

        Returns:
            PortalHealResult with healed/skipped/error sections.
        """
        if missing_sections is None or missing_markers is None:
            check = self.verify_portal(client_id, portal_page_id)
            if missing_sections is None:
                missing_sections = check.missing_sections
            if missing_markers is None:
                missing_markers = check.missing_markers

        result = PortalHealResult(client_id=client_id, simulate=simulate)

        if not missing_sections and not missing_markers:
            return result

        if simulate:
            result.healed_sections = list(missing_sections)
            result.healed_markers = list(missing_markers)
            return result

        if not portal_page_id or not self.notion:
            result.errors.append("Cannot heal: no portal_page_id or notion client")
            result.skipped_sections = list(missing_sections)
            return result

        # Build all blocks to append in one batch
        children: list[dict[str, Any]] = []

        for section in missing_sections:
            children.append(self._heading_block(section))
            result.healed_sections.append(section)

        for marker_key in missing_markers:
            if marker_key in self.markers:
                begin, end = self.markers[marker_key]
                children.append(self._marker_block(begin, end, f"{marker_key} placeholder"))
                result.healed_markers.append(marker_key)

        # Append all blocks in one API call
        if children:
            try:
                self._append_block_children(portal_page_id, children)
            except Exception as exc:
                result.errors.append(f"Failed to append blocks: {exc}")
                result.skipped_sections = list(missing_sections)
                result.healed_sections = []
                result.healed_markers = []
                return result

        # Update portal_compliance table
        now = utc_now_iso()
        try:
            self.conn.execute(
                "UPDATE portal_compliance SET last_healed_at=?, updated_at=? WHERE client_id=?",
                (now, now, client_id),
            )
            self.conn.commit()
        except Exception:
            pass

        return result

    def replace_between_markers(
        self,
        portal_page_id: str,
        marker_key: str,
        new_content: str,
        page_content: list[dict[str, Any]] | None = None,
    ) -> bool:
        """Replace content between marker tags in a portal page.

        Finds the paragraph block containing the BEGIN marker, replaces its content
        with BEGIN marker + new_content + END marker.

        Args:
            portal_page_id: Notion page ID.
            marker_key: Key from MARKERS dict (e.g. 'SYSTEM_NOTES').
            new_content: New content to place between markers.
            page_content: Pre-fetched blocks (for testing).

        Returns:
            True if replacement succeeded, False otherwise.
        """
        if marker_key not in self.markers:
            return False

        begin, end = self.markers[marker_key]

        if page_content is None and self.notion:
            page_content = self._fetch_page_blocks(portal_page_id)

        if not page_content:
            return False

        # Find the block containing the BEGIN marker
        target_block_id = None
        for block in page_content:
            block_text = self._block_plain_text(block)
            if begin in block_text:
                target_block_id = block.get("id")
                break

        if not target_block_id or not self.notion:
            return False

        # Replace the block content
        replacement_text = f"{begin}\n{new_content}\n{end}"
        try:
            self.notion._limiter.acquire()
            self.notion._client.patch(
                f"{self.notion.base_url}/blocks/{target_block_id}",
                json={
                    "paragraph": {
                        "rich_text": [{"type": "text", "text": {"content": replacement_text}}],
                    },
                },
                headers=self.notion._headers(),
            )
            return True
        except Exception as exc:
            log.warning("marker_replace_failed", extra={"marker": marker_key, "error": str(exc)})
            return False

    def verify_all_portals(self) -> list[PortalComplianceResult]:
        """Verify all client portals tracked in portal_compliance table."""
        results: list[PortalComplianceResult] = []
        try:
            rows = self.conn.execute(
                "SELECT client_id, portal_page_id FROM portal_compliance"
            ).fetchall()
        except Exception:
            return results

        for row in rows:
            result = self.verify_portal(row["client_id"], row["portal_page_id"])
            results.append(result)

        return results

    def register_portal(self, client_id: str, portal_page_id: str) -> None:
        """Register a client portal page for compliance tracking."""
        now = utc_now_iso()
        self.conn.execute(
            """INSERT INTO portal_compliance
               (client_id, portal_page_id, compliant, created_at, updated_at)
               VALUES (?, ?, 0, ?, ?)
               ON CONFLICT(client_id) DO UPDATE SET
                 portal_page_id=excluded.portal_page_id,
                 updated_at=excluded.updated_at""",
            (client_id, portal_page_id, now, now),
        )
        self.conn.commit()

    # ─────────────────────────────────────────
    # Internal helpers
    # ─────────────────────────────────────────

    def _fetch_page_blocks(self, page_id: str) -> list[dict[str, Any]]:
        """Fetch child blocks of a Notion page."""
        try:
            self.notion._limiter.acquire()
            resp = self.notion._client.get(
                f"{self.notion.base_url}/blocks/{page_id}/children",
                headers=self.notion._headers(),
            )
            resp.raise_for_status()
            return resp.json().get("results", [])
        except Exception as exc:
            log.warning("portal_blocks_fetch_failed", extra={"page_id": page_id, "error": str(exc)})
            return []

    def _append_block_children(
        self, page_id: str, children: list[dict[str, Any]]
    ) -> None:
        """Append blocks to a Notion page."""
        self.notion._limiter.acquire()
        resp = self.notion._client.patch(
            f"{self.notion.base_url}/blocks/{page_id}/children",
            json={"children": children},
            headers=self.notion._headers(),
        )
        resp.raise_for_status()

    def _extract_headings(self, blocks: list[dict[str, Any]]) -> list[str]:
        """Extract heading text from blocks."""
        out: list[str] = []
        for b in blocks:
            t = b.get("type")
            if t in ("heading_1", "heading_2", "heading_3"):
                rt = b[t].get("rich_text", [])
                text = "".join(x.get("plain_text", "") for x in rt).strip()
                if text:
                    out.append(text)
        return out

    def _concat_plain_text(self, blocks: list[dict[str, Any]]) -> str:
        """Concatenate all plain text from blocks for marker detection."""
        parts: list[str] = []
        for b in blocks:
            text = self._block_plain_text(b)
            if text:
                parts.append(text)
        return "\n".join(parts)

    def _block_plain_text(self, block: dict[str, Any]) -> str:
        """Extract plain text from any block type."""
        t = block.get("type")
        if t in ("paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "quote", "callout"):
            rt = block.get(t, {}).get("rich_text", [])
            return "".join(x.get("plain_text", "") for x in rt)
        return ""

    def _heading_block(self, title: str) -> dict[str, Any]:
        """Build a heading_2 block."""
        return {
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"type": "text", "text": {"content": title}}],
            },
        }

    def _marker_block(
        self, begin: str, end: str, default_body: str
    ) -> dict[str, Any]:
        """Build a paragraph block with marker tags."""
        body = f"{begin}\n{default_body}\n{end}"
        return {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": body}}],
            },
        }

    def _persist_result(self, result: PortalComplianceResult) -> None:
        """Save compliance result to portal_compliance table."""
        now = utc_now_iso()
        missing_str = ",".join(result.missing_sections) if result.missing_sections else None
        try:
            self.conn.execute(
                """INSERT INTO portal_compliance
                   (client_id, portal_page_id, compliant, missing_sections, last_checked_at, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(client_id) DO UPDATE SET
                     compliant=excluded.compliant,
                     missing_sections=excluded.missing_sections,
                     last_checked_at=excluded.last_checked_at,
                     updated_at=excluded.updated_at""",
                (result.client_id, result.portal_page_id, int(result.compliant), missing_str, now, now, now),
            )
            self.conn.commit()
        except Exception:
            pass
