from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from packages.common.config import settings
from packages.common.logging import get_logger
from packages.integrations.trello.client import TrelloClient

log = get_logger("trello_lists")


@dataclass(frozen=True)
class CanonicalClientLists:
    requests: str = "Requests"
    in_progress: str = "In Progress"
    needs_review: str = "Needs Review / Feedback"
    approved_ready: str = "Approved / Ready for Delivery"
    published: str = "Published / Delivered"
    reference: str = "Reference & Links"


@dataclass(frozen=True)
class CanonicalInternalLists:
    inbox: str = "Inbox"
    assigned: str = "Assigned"
    in_progress: str = "In Progress"
    review: str = "Review"
    completed: str = "Completed"
    archived: str = "Archived"


def _normalize(s: str) -> str:
    return (s or "").strip().lower()


def resolve_list_id_by_name(lists: list[dict[str, Any]], name: str) -> str | None:
    """Resolve list ID by name: exact match first, then case-insensitive."""
    for lst in lists:
        if lst.get("name") == name:
            return lst.get("id")
    target = _normalize(name)
    for lst in lists:
        if _normalize(lst.get("name", "")) == target:
            return lst.get("id")
    return None


def ensure_list_exists(*, board_id: str, list_name: str, tc: TrelloClient) -> str:
    """Resolve or auto-create a list on the given board."""
    lists = tc.get_lists(board_id=board_id)
    lid = resolve_list_id_by_name(lists, list_name)
    if lid:
        return lid

    if settings.DRY_RUN or settings.SAFE_MODE:
        log.info(f"[SAFE/DRY] would create list '{list_name}' on board {board_id}")
        return f"dry_list_{_normalize(list_name).replace(' ', '_')}"

    created = tc.create_list(board_id=board_id, name=list_name)
    return created["id"]


def ensure_client_board_schema(board_id: str, tc: TrelloClient) -> dict[str, str]:
    """Ensure all canonical client lists exist on the board."""
    c = CanonicalClientLists()
    mapping: dict[str, str] = {}
    for name in [c.requests, c.in_progress, c.needs_review, c.approved_ready, c.published, c.reference]:
        mapping[name] = ensure_list_exists(board_id=board_id, list_name=name, tc=tc)
    return mapping


def ensure_internal_board_schema(board_id: str, tc: TrelloClient) -> dict[str, str]:
    """Ensure all canonical internal lists exist on the board."""
    i = CanonicalInternalLists()
    mapping: dict[str, str] = {}
    for name in [i.inbox, i.assigned, i.in_progress, i.review, i.completed, i.archived]:
        mapping[name] = ensure_list_exists(board_id=board_id, list_name=name, tc=tc)
    return mapping


def resolve_list_ids_by_name(tc: TrelloClient, *, board_id: str) -> dict[str, str]:
    """Return {list_name: list_id} map for all lists on a board."""
    lists = tc.get_lists(board_id=board_id)
    return {str(lst.get("name", "")): str(lst.get("id", "")) for lst in lists}
