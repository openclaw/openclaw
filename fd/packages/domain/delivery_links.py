"""Canonical merge of draft/final links into the DELIVERY_LINKS marked block.

Schema (v4):
  {
    "type": "delivery_links",
    "draft": [{"url": "...", "ts": ..., "by": "internal|system", "note": "...", "version": 1}],
    "final": [{"url": "...", "ts": ..., "by": "internal|system", "note": "...", "version": 1}],
    "current_draft_url": "..." | null,
    "current_final_url": "..." | null,
    "last_delivery_event_id": "..." | null,
    "truth_badge": "in_progress",
    "release_date": "2026-03-15" | null,
    "updated_ts": ...,
    "source": "...",
    "correlation_id": "..."
  }

Entries are deduplicated by url. Existing entries are never overwritten or deleted.
Current pointers always point to the latest added url for instant visibility.
truth_badge uses precedence — never downgrades unless explicitly forced.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.domain.trello_cards import upsert_marked_json_merge

BEGIN = settings.MARKER_BEGIN_DELIVERY_LINKS
END = settings.MARKER_END_DELIVERY_LINKS

VALID_BADGES = frozenset({
    "intake",
    "in_progress",
    "ready_for_review",
    "approved_ready",
    "scheduled_publish",
    "published",
    "needs_attention",
})

# Ordered by precedence — higher index = higher precedence.
# "needs_attention" is special: same level as intake (lowest actionable).
_TRUTH_PRECEDENCE = [
    "needs_attention",
    "intake",
    "in_progress",
    "ready_for_review",
    "approved_ready",
    "scheduled_publish",
    "published",
]


def _truth_rank(badge: str | None) -> int:
    if not badge:
        return 0
    try:
        return _TRUTH_PRECEDENCE.index(badge)
    except ValueError:
        return 0


def _merge_truth(existing: str | None, incoming: str | None) -> str:
    """Return the higher-precedence badge (never downgrade)."""
    if not incoming:
        return existing or "in_progress"
    if not existing:
        return incoming
    return incoming if _truth_rank(incoming) >= _truth_rank(existing) else existing


def _normalize_entries(raw: list[Any]) -> list[dict[str, Any]]:
    """Convert legacy flat strings or objects into canonical {url, ts, by, note, version}."""
    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, str):
            out.append({"url": item, "ts": now_ts(), "by": "system", "note": "", "version": 1})
        elif isinstance(item, dict) and "url" in item:
            # Backfill missing fields
            item.setdefault("by", "system")
            item.setdefault("note", "")
            item.setdefault("version", 1)
            out.append(item)
    return out


def _dedupe_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate entries by url, keeping the first (oldest) occurrence."""
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for e in entries:
        url = e.get("url", "")
        if url and url not in seen:
            seen.add(url)
            result.append(e)
    return result


def _next_version(entries: list[dict[str, Any]]) -> int:
    """Compute next version number from existing entries."""
    if not entries:
        return 1
    return 1 + max((e.get("version", 0) for e in entries if isinstance(e, dict)), default=0)


def _latest_url(entries: list[dict[str, Any]]) -> str | None:
    """Return the url from the most recently added entry (highest ts), or None."""
    if not entries:
        return None
    best = max(entries, key=lambda e: e.get("ts", 0))
    return best.get("url")


def _empty_block() -> dict[str, Any]:
    return {
        "type": "delivery_links",
        "draft": [],
        "final": [],
        "current_draft_url": None,
        "current_final_url": None,
        "last_delivery_event_id": None,
        "truth_badge": "in_progress",
        "release_date": None,
        "updated_ts": now_ts(),
    }


def get_delivery_links(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Read-only fetch of the delivery links block. Returns parsed dict or empty."""
    def _passthrough(existing: dict[str, Any] | None) -> dict[str, Any]:
        base = existing if isinstance(existing, dict) else {}
        if base.get("type") != "delivery_links":
            return _empty_block()
        return base

    result = upsert_marked_json_merge(
        conn,
        card_id=card_id,
        begin_marker=BEGIN,
        end_marker=END,
        merge_fn=_passthrough,
        correlation_id=correlation_id,
    )
    return result.get("merged") or _empty_block()


def merge_delivery_links(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    draft_urls: list[str] | None = None,
    final_urls: list[str] | None = None,
    by: str = "system",
    note: str | None = None,
    source: str = "auto_detected",
    delivery_event_id: str | None = None,
    suggested_truth_badge: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Merge draft/final URLs into the delivery links block.

    - Preserves existing draft/final entries (full history, never deletes)
    - Deduplicates by url per list
    - Appends new entries as {url, ts, by, note, version}
    - Maintains current_draft_url / current_final_url pointers
    - truth_badge uses precedence (never downgrades)
    - Preserves release_date and unrelated fields
    """
    clean_drafts = [u.strip() for u in (draft_urls or []) if u and u.strip()]
    clean_finals = [u.strip() for u in (final_urls or []) if u and u.strip()]

    def _merge(existing: dict[str, Any] | None) -> dict[str, Any]:
        base = existing if isinstance(existing, dict) else {}
        if base.get("type") != "delivery_links":
            base = _empty_block()

        draft = _normalize_entries(base.get("draft") or [])
        final = _normalize_entries(base.get("final") or [])

        # Existing URL sets for dedup
        draft_seen = {e.get("url") for e in draft if isinstance(e, dict)}
        final_seen = {e.get("url") for e in final if isinstance(e, dict)}

        ts = now_ts()
        ver = _next_version(draft)

        # Append new draft entries
        for u in clean_drafts:
            if u in draft_seen:
                continue
            draft.append({"url": u, "ts": ts, "by": by, "note": note or "", "version": ver})
            ver += 1
            draft_seen.add(u)

        ver = _next_version(final)
        # Append new final entries
        for u in clean_finals:
            if u in final_seen:
                continue
            final.append({"url": u, "ts": ts, "by": by, "note": note or "", "version": ver})
            ver += 1
            final_seen.add(u)

        # Current pointers: newest added wins; else preserve existing
        cur_draft = base.get("current_draft_url")
        if clean_drafts:
            cur_draft = clean_drafts[-1]
        elif not cur_draft:
            cur_draft = _latest_url(draft)

        cur_final = base.get("current_final_url")
        if clean_finals:
            cur_final = clean_finals[-1]
        elif not cur_final:
            cur_final = _latest_url(final)

        # truth_badge: never downgrade
        badge = _merge_truth(base.get("truth_badge"), suggested_truth_badge)

        return {
            "type": "delivery_links",
            "draft": draft,
            "final": final,
            "current_draft_url": cur_draft,
            "current_final_url": cur_final,
            "last_delivery_event_id": delivery_event_id or base.get("last_delivery_event_id"),
            "truth_badge": badge,
            "release_date": base.get("release_date"),
            "updated_ts": ts,
            "source": source,
            "correlation_id": correlation_id,
        }

    result = upsert_marked_json_merge(
        conn,
        card_id=card_id,
        begin_marker=BEGIN,
        end_marker=END,
        merge_fn=_merge,
        correlation_id=correlation_id,
    )

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    write_audit(
        conn,
        action="delivery_links.merge",
        target=card_id,
        payload={
            "mode": mode,
            "new_drafts": len(clean_drafts),
            "new_finals": len(clean_finals),
            "by": by,
            "source": source,
            "delivery_event_id": delivery_event_id,
            "suggested_truth_badge": suggested_truth_badge,
        },
        correlation_id=correlation_id,
    )
    return result


def set_truth_badge(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    badge: str,
    release_date: str | None = None,
    force: bool = False,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Update truth_badge (and optionally release_date) without clobbering draft/final arrays.

    By default uses precedence (never downgrades). Set force=True to override.
    """
    if badge not in VALID_BADGES:
        badge = "needs_attention"

    def _merge(existing: dict[str, Any] | None) -> dict[str, Any]:
        base = existing if isinstance(existing, dict) else {}
        draft = _normalize_entries(base.get("draft") or [])
        final = _normalize_entries(base.get("final") or [])
        rd = release_date if release_date is not None else base.get("release_date")

        if force:
            resolved_badge = badge
        else:
            resolved_badge = _merge_truth(base.get("truth_badge"), badge)

        return {
            "type": "delivery_links",
            "draft": draft,
            "final": final,
            "current_draft_url": base.get("current_draft_url"),
            "current_final_url": base.get("current_final_url"),
            "last_delivery_event_id": base.get("last_delivery_event_id"),
            "truth_badge": resolved_badge,
            "release_date": rd,
            "updated_ts": now_ts(),
            "correlation_id": correlation_id,
        }

    result = upsert_marked_json_merge(
        conn,
        card_id=card_id,
        begin_marker=BEGIN,
        end_marker=END,
        merge_fn=_merge,
        correlation_id=correlation_id,
    )

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    write_audit(
        conn,
        action="delivery_links.set_truth_badge",
        target=card_id,
        payload={"mode": mode, "badge": badge, "release_date": release_date, "force": force},
        correlation_id=correlation_id,
    )
    return result
