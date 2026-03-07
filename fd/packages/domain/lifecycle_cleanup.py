from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.idempotency import seen_or_mark
from packages.domain.cleanup_summary import upsert_cleanup_summary_block
from packages.domain.fulfillment_state import mark_fulfillment_archived
from packages.domain.sync import get_fulfillment_by_board, get_primary_card_and_lists
from packages.domain.timeline import log_timeline_event
from packages.domain.trello_webhook_registry import (
    deactivate_webhook,
    get_active_webhook_by_board,
)
from packages.integrations.trello.client import TrelloClient


def _parse_json_list(s: str) -> list[str]:
    try:
        v = json.loads(s or "[]")
        if isinstance(v, list):
            return [str(x) for x in v]
    except Exception:
        pass
    return []


def _parse_json_dict(s: str) -> dict[str, bool]:
    try:
        v = json.loads(s or "{}")
        if isinstance(v, dict):
            out: dict[str, bool] = {}
            for k, val in v.items():
                if isinstance(val, bool):
                    out[str(k)] = val
                elif isinstance(val, str) and val.lower() in ("true", "false"):
                    out[str(k)] = val.lower() == "true"
            return out
    except Exception:
        pass
    return {}


def offer_close_board_override(offer_key: str | None) -> bool | None:
    if not offer_key:
        return None
    mapping = _parse_json_dict(settings.OFFER_CLEANUP_CLOSE_BOARD_JSON or "{}")
    return mapping.get(str(offer_key))


def cleanup_stage_ids() -> list[str]:
    return _parse_json_list(settings.CLEANUP_ON_GHL_STAGE_IDS_JSON)


def cleanup_list_names() -> list[str]:
    return _parse_json_list(settings.CLEANUP_ON_TRELLO_LIST_NAMES_JSON)


def run_cleanup(
    conn: sqlite3.Connection,
    *,
    source: str,
    source_event_id: str,
    trello_board_id: str,
    correlation_id: str | None,
    reason: str,
    offer_key: str | None = None,
) -> dict[str, Any]:
    """
    Lifecycle cleanup: optionally move primary card to archive list,
    delete board webhook (if any), optionally close board, mark archived.
    Idempotent on (source, source_event_id).
    """
    idem_key = f"lifecycle:{source}:{source_event_id}"
    if seen_or_mark(conn, key=idem_key):
        return {"ok": True, "duplicate": True, "idempotency_key": idem_key}

    active = get_active_webhook_by_board(conn, trello_board_id)

    override = offer_close_board_override(offer_key)
    close_board = override if override is not None else settings.TRELLO_CLOSE_BOARD_ON_CLEANUP

    move_primary = settings.TRELLO_MOVE_PRIMARY_CARD_ON_CLEANUP
    archive_list_name = settings.TRELLO_ARCHIVE_LIST_NAME or "Archived"

    apply_label = settings.TRELLO_APPLY_ARCHIVED_LABEL_ON_CLEANUP
    autocreate_label = settings.TRELLO_AUTOCREATE_ARCHIVED_LABEL_ON_CLEANUP
    archived_label_name = settings.TRELLO_ARCHIVED_LABEL_NAME or "Archived"

    add_comment = settings.TRELLO_ADD_CLEANUP_COMMENT_ON_CLEANUP

    if settings.DRY_RUN:
        write_audit(
            conn,
            action="lifecycle.cleanup(dry_run)",
            target="lifecycle",
            payload={
                "source": source,
                "source_event_id": source_event_id,
                "trello_board_id": trello_board_id,
                "reason": reason,
                "active_webhook": active,
                "close_board": close_board,
                "move_primary_card": move_primary,
                "archive_list_name": archive_list_name,
                "autocreate_archive_list": settings.TRELLO_AUTOCREATE_ARCHIVE_LIST_ON_CLEANUP,
                "apply_archived_label": apply_label,
                "autocreate_archived_label": autocreate_label,
                "archived_label_name": archived_label_name,
                "add_cleanup_comment": add_comment,
                "offer_key": offer_key,
                "offer_override": override,
            },
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "trello_board_id": trello_board_id}

    tc = TrelloClient()

    # Resolve primary card id + known list_ids from fulfillment metadata (best-effort)
    job = get_fulfillment_by_board(conn, trello_board_id)
    primary_card_id = None
    list_ids_by_name: dict[str, str] = {}
    if job:
        primary_card_id, list_ids_by_name = get_primary_card_and_lists(
            str(job.get("metadata_json") or "")
        )

    moved_primary = False
    move_error: str | None = None

    if move_primary and primary_card_id:
        try:
            # Find archive list id (prefer stored list_ids; otherwise fetch from Trello)
            target_list_id = list_ids_by_name.get(archive_list_name)

            if not target_list_id:
                lists = tc.get_lists(board_id=trello_board_id)
                for lst in lists:
                    if str(lst.get("name")) == archive_list_name:
                        target_list_id = str(lst.get("id"))
                        break

            # Auto-create archive list if missing
            if not target_list_id and settings.TRELLO_AUTOCREATE_ARCHIVE_LIST_ON_CLEANUP:
                created = tc.create_list(board_id=trello_board_id, name=archive_list_name)
                target_list_id = str(created.get("id"))
                write_audit(
                    conn,
                    action="trello.archive_list.autocreated",
                    target="trello",
                    payload={
                        "trello_board_id": trello_board_id,
                        "archive_list_name": archive_list_name,
                        "list_id": target_list_id,
                    },
                    correlation_id=correlation_id,
                )

            if target_list_id:
                tc.move_card(card_id=primary_card_id, list_id=target_list_id)
                moved_primary = True
            else:
                move_error = f"archive_list_not_found:{archive_list_name}"
        except Exception as e:
            move_error = str(e)

        write_audit(
            conn,
            action="trello.move_primary_card_on_cleanup",
            target="trello",
            payload={
                "trello_board_id": trello_board_id,
                "primary_card_id": primary_card_id,
                "archive_list_name": archive_list_name,
                "moved": moved_primary,
                "error": move_error,
            },
            correlation_id=correlation_id,
        )
    else:
        write_audit(
            conn,
            action="trello.move_primary_card_on_cleanup.skipped",
            target="trello",
            payload={
                "trello_board_id": trello_board_id,
                "move_primary": move_primary,
                "primary_card_id_present": bool(primary_card_id),
                "archive_list_name": archive_list_name,
            },
            correlation_id=correlation_id,
        )

    label_applied = False
    label_error: str | None = None
    label_id: str | None = None

    if apply_label and primary_card_id:
        try:
            # Find label by name on board
            labels = tc.get_labels(board_id=trello_board_id)
            for lbl in labels:
                if str(lbl.get("name") or "") == archived_label_name:
                    label_id = str(lbl.get("id"))
                    break

            # Auto-create label if missing
            if not label_id and autocreate_label:
                created_lbl = tc.create_label(
                    board_id=trello_board_id, name=archived_label_name, color="yellow"
                )
                label_id = str(created_lbl.get("id"))
                write_audit(
                    conn,
                    action="trello.archived_label.autocreated",
                    target="trello",
                    payload={
                        "trello_board_id": trello_board_id,
                        "label_name": archived_label_name,
                        "label_id": label_id,
                    },
                    correlation_id=correlation_id,
                )

            if label_id:
                tc.add_label_to_card(card_id=primary_card_id, label_id=label_id)
                label_applied = True
            else:
                label_error = f"label_not_found:{archived_label_name}"

        except Exception as e:
            label_error = str(e)

        write_audit(
            conn,
            action="trello.apply_archived_label_on_cleanup",
            target="trello",
            payload={
                "trello_board_id": trello_board_id,
                "primary_card_id": primary_card_id,
                "label_name": archived_label_name,
                "label_id": label_id,
                "applied": label_applied,
                "error": label_error,
            },
            correlation_id=correlation_id,
        )
    else:
        write_audit(
            conn,
            action="trello.apply_archived_label_on_cleanup.skipped",
            target="trello",
            payload={
                "trello_board_id": trello_board_id,
                "apply_label": apply_label,
                "primary_card_id_present": bool(primary_card_id),
                "label_name": archived_label_name,
            },
            correlation_id=correlation_id,
        )

    deleted_webhook_id = None
    if active:
        webhook_id = str(active["trello_webhook_id"])
        tc.delete_webhook(webhook_id=webhook_id)
        deactivate_webhook(conn, webhook_id)
        deleted_webhook_id = webhook_id

    closed = False
    if close_board:
        tc.close_board(board_id=trello_board_id)
        closed = True

    mark_fulfillment_archived(conn, trello_board_id=trello_board_id, reason=reason)

    # Post cleanup summary via unified timeline logger
    comment_posted = False
    comment_error: str | None = None
    if add_comment:
        tl_result = log_timeline_event(
            conn,
            trello_board_id=trello_board_id,
            event_type="cleanup_completed",
            event_key=f"{source}:{source_event_id}",
            title="Cleanup Completed",
            human_fields={
                "Reason": reason,
                "Correlation ID": correlation_id or "N/A",
                "Source": source,
                "Source Event ID": source_event_id,
                "Offer Key": offer_key or "N/A",
                "Board Closed": close_board,
                "Primary Card Moved": moved_primary,
                "Archived Label Applied": label_applied,
                "Webhook Deleted": bool(deleted_webhook_id),
            },
            machine_fields={
                "reason": reason,
                "source": source,
                "source_event_id": source_event_id,
                "offer_key": offer_key,
                "close_board": close_board,
                "primary_card_moved": moved_primary,
                "archived_label_applied": label_applied,
                "deleted_webhook_id": deleted_webhook_id,
            },
            correlation_id=correlation_id,
            primary_card_id=primary_card_id,
        )
        comment_posted = tl_result.get("ok", False) and tl_result.get("mode") == "live"
        comment_error = tl_result.get("error")

    # Canonical cleanup summary block on primary card description
    if primary_card_id:
        upsert_cleanup_summary_block(
            conn,
            card_id=primary_card_id,
            reason=reason,
            correlation_id=correlation_id,
            extra={
                "trello_webhook_deleted": bool(deleted_webhook_id),
                "board_closed": closed,
                "primary_card_moved": moved_primary,
                "archived_label_applied": label_applied,
            },
        )

    write_audit(
        conn,
        action="lifecycle.cleanup",
        target="lifecycle",
        payload={
            "source": source,
            "source_event_id": source_event_id,
            "trello_board_id": trello_board_id,
            "deleted_webhook_id": deleted_webhook_id,
            "board_closed": closed,
            "primary_card_moved": moved_primary,
            "primary_card_move_error": move_error,
            "archive_list_name": archive_list_name,
            "archived_label_applied": label_applied,
            "archived_label_error": label_error,
            "archived_label_name": archived_label_name,
            "cleanup_comment_posted": comment_posted,
            "cleanup_comment_error": comment_error,
            "reason": reason,
            "offer_key": offer_key,
            "offer_override": override,
        },
        correlation_id=correlation_id,
    )

    return {
        "ok": True,
        "mode": "live",
        "trello_board_id": trello_board_id,
        "deleted_webhook_id": deleted_webhook_id,
        "board_closed": closed,
        "primary_card_moved": moved_primary,
        "primary_card_move_error": move_error,
        "archive_list_name": archive_list_name,
        "archived_label_applied": label_applied,
        "archived_label_error": label_error,
        "archived_label_name": archived_label_name,
        "cleanup_comment_posted": comment_posted,
        "cleanup_comment_error": comment_error,
    }
