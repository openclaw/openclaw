"""Trello Due Date Sync — pulls cards with due dates into schedule_events.

Reads Trello boards, extracts cards with due dates, and upserts them
as schedule_events with source='trello' and external_key='trello:<board_id>:<card_id>:due'.

Idempotent: uses ON CONFLICT(source, external_key) for dedup.
Read-only on Trello side — never mutates Trello cards.

Trello is authoritative for deadlines. All Trello due items are all-day entries.
By default, Trello due dates are NOT written into Google Calendar
(controlled by GCAL_WRITE_TRELLO_DUE=false).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from packages.agencyu.schedule.models import ScheduleEvent
from packages.agencyu.schedule.repo import ScheduleRepo
from packages.common.logging import get_logger
from packages.integrations.trello.client import TrelloClient

log = get_logger("agencyu.schedule.trello_due_sync")


def _trello_external_key(board_id: str, card_id: str) -> str:
    """Stable external key: trello:<board_id>:<card_id>:due."""
    return f"trello:{board_id}:{card_id}:due"


def sync_board_due_dates(
    trello: TrelloClient,
    repo: ScheduleRepo,
    board_id: str,
    brand: str,
) -> dict[str, Any]:
    """Pull all cards with due dates from a Trello board into schedule_events.

    Returns summary of sync results.
    """
    try:
        cards = trello.get_board_cards(board_id)
    except Exception as exc:
        log.warning("trello_due_sync_fetch_error", extra={"board_id": board_id, "error": str(exc)})
        return {"ok": False, "error": str(exc), "board_id": board_id}

    synced = 0
    skipped = 0
    errors = 0
    seen_keys: set[str] = set()

    for card in cards:
        due = card.get("due")
        if not due:
            skipped += 1
            continue

        card_id = card.get("id", "")
        ext_key = _trello_external_key(board_id, card_id)
        seen_keys.add(ext_key)

        try:
            due_dt = datetime.fromisoformat(due.replace("Z", "+00:00"))
            event = ScheduleEvent(
                brand=brand,
                source="trello",
                external_key=ext_key,
                event_type="deadline",
                title=card.get("name", "Untitled"),
                start_time=due_dt,
                all_day=True,
                trello_card_id=card_id,
                status="completed" if card.get("dueComplete") else "scheduled",
                notes=f"Board: {board_id}",
            )
            repo.upsert(event)
            synced += 1
        except Exception as exc:
            log.warning("trello_due_sync_card_error", extra={
                "card_id": card_id, "error": str(exc),
            })
            errors += 1

    # Remove stale entries for cards whose due was removed or card deleted
    removed = _remove_stale_trello_events(repo, board_id, seen_keys)

    log.info("trello_due_sync_complete", extra={
        "board_id": board_id,
        "brand": brand,
        "synced": synced,
        "skipped": skipped,
        "errors": errors,
        "removed": removed,
    })

    return {
        "ok": errors == 0,
        "board_id": board_id,
        "brand": brand,
        "synced": synced,
        "skipped": skipped,
        "errors": errors,
        "removed": removed,
    }


def _remove_stale_trello_events(
    repo: ScheduleRepo,
    board_id: str,
    seen_keys: set[str],
) -> int:
    """Soft-delete Trello events that no longer exist in the source board."""
    prefix = f"trello:{board_id}:"
    rows = repo.conn.execute(
        "SELECT id, external_key FROM schedule_events WHERE source='trello' AND external_key LIKE ? AND status != 'cancelled'",
        (f"{prefix}%",),
    ).fetchall()

    removed = 0
    for row in rows:
        if row["external_key"] not in seen_keys:
            repo.conn.execute(
                "UPDATE schedule_events SET status='cancelled', updated_at=datetime('now') WHERE id=?",
                (row["id"],),
            )
            removed += 1
    if removed:
        repo.conn.commit()
    return removed


def sync_all_boards(
    trello: TrelloClient,
    repo: ScheduleRepo,
    board_brand_map: dict[str, str],
) -> list[dict[str, Any]]:
    """Sync due dates from multiple boards.

    Args:
        board_brand_map: {board_id: brand_key} mapping.
    """
    results = []
    for board_id, brand in board_brand_map.items():
        result = sync_board_due_dates(trello, repo, board_id, brand)
        results.append(result)
    return results
