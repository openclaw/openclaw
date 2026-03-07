from __future__ import annotations

import json
import sqlite3
import time
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.common.ids import new_id
from packages.domain.sync import get_fulfillment_by_board, get_primary_card_and_lists
from packages.integrations.trello.client import TrelloClient


def _parse_json_list(s: str) -> list[str]:
    try:
        v = json.loads(s or "[]")
        if isinstance(v, list):
            return [str(x) for x in v]
    except Exception:
        pass
    return []


def _allowed(event_type: str) -> bool:
    if not settings.TIMELINE_LOG_ENABLED:
        return False
    allow = _parse_json_list(settings.TIMELINE_ALLOWED_EVENT_TYPES_JSON)
    return True if not allow else (event_type in set(allow))


def _format_comment(*, title: str, lines: dict[str, Any], machine: dict[str, Any]) -> str:
    ts = machine.get("timestamp_utc") or datetime.now(UTC).isoformat()
    header = f"{title}\n\nTimestamp (UTC): {ts}\n"
    body = "".join(
        [f"{k}: {('N/A' if v is None or v == '' else v)}\n" for k, v in lines.items()]
    )
    marker = settings.TIMELINE_JSON_MARKER or "[OPENCLAW_JSON]"
    machine_json = json.dumps(machine, separators=(",", ":"), ensure_ascii=False)
    return f"{header}{body}\n{marker}\n{machine_json}"


def _upsert_timeline_row(
    conn: sqlite3.Connection,
    *,
    timeline_id: str,
    trello_board_id: str,
    primary_card_id: str | None,
    event_type: str,
    event_key: str,
    correlation_id: str | None,
    payload: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO lifecycle_timeline
        (timeline_id, ts, trello_board_id, primary_card_id, event_type, event_key,
         correlation_id, payload_json, posted_to_trello, post_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            timeline_id,
            int(time.time()),
            trello_board_id,
            primary_card_id,
            event_type,
            event_key,
            correlation_id,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            0,
            None,
        ),
    )
    conn.commit()


def _mark_posted(conn: sqlite3.Connection, timeline_id: str, ok: bool, err: str | None) -> None:
    conn.execute(
        """
        UPDATE lifecycle_timeline
        SET posted_to_trello = ?, post_error = ?
        WHERE timeline_id = ?
        """,
        (1 if ok else 0, err, timeline_id),
    )
    conn.commit()


def log_timeline_event(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str,
    event_type: str,
    event_key: str,
    title: str,
    human_fields: dict[str, Any],
    machine_fields: dict[str, Any],
    correlation_id: str | None = None,
    primary_card_id: str | None = None,
) -> dict[str, Any]:
    """
    Writes a lifecycle timeline entry + posts to Trello primary card (live mode).
    Idempotent by (event_type, event_key).
    """
    if not _allowed(event_type):
        write_audit(
            conn,
            action="timeline.log.skipped_disabled_or_filtered",
            target="timeline",
            payload={
                "event_type": event_type,
                "event_key": event_key,
                "trello_board_id": trello_board_id,
            },
            correlation_id=correlation_id,
        )
        return {"ok": True, "skipped": True}

    # Resolve primary card from fulfillment job if not provided
    if not primary_card_id:
        job = get_fulfillment_by_board(conn, trello_board_id)
        if job:
            primary_card_id, _ = get_primary_card_and_lists(
                str(job.get("metadata_json") or "")
            )

    # Stable timeline id
    timeline_id = f"{event_type}:{event_key}"

    ts = datetime.now(UTC).isoformat()
    machine = {
        "type": "openclaw_timeline",
        "event_type": event_type,
        "event_key": event_key,
        "timestamp_utc": ts,
        "trello_board_id": trello_board_id,
        "primary_card_id": primary_card_id,
        "correlation_id": correlation_id,
        **machine_fields,
    }

    payload = {"human": human_fields, "machine": machine}

    # Persist locally first (so we don't lose the event if Trello fails)
    _upsert_timeline_row(
        conn,
        timeline_id=timeline_id,
        trello_board_id=trello_board_id,
        primary_card_id=primary_card_id,
        event_type=event_type,
        event_key=event_key,
        correlation_id=correlation_id,
        payload=payload,
    )

    comment = _format_comment(title=title, lines=human_fields, machine=machine)

    if settings.DRY_RUN:
        write_audit(
            conn,
            action="timeline.log(dry_run)",
            target="timeline",
            payload={
                "timeline_id": timeline_id,
                "trello_board_id": trello_board_id,
                "primary_card_id": primary_card_id,
            },
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "timeline_id": timeline_id}

    if not primary_card_id:
        err = "missing_primary_card_id"
        _mark_posted(conn, timeline_id, ok=False, err=err)
        write_audit(
            conn,
            action="timeline.log.failed_missing_primary_card",
            target="timeline",
            payload={"timeline_id": timeline_id, "trello_board_id": trello_board_id},
            correlation_id=correlation_id,
        )
        return {"ok": False, "timeline_id": timeline_id, "error": err}

    tc = TrelloClient()
    try:
        tc.add_comment_to_card(card_id=primary_card_id, text=comment)
        _mark_posted(conn, timeline_id, ok=True, err=None)
        write_audit(
            conn,
            action="timeline.log.posted",
            target="timeline",
            payload={
                "timeline_id": timeline_id,
                "trello_board_id": trello_board_id,
                "primary_card_id": primary_card_id,
            },
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "live", "timeline_id": timeline_id}
    except Exception as e:
        err = str(e)
        _mark_posted(conn, timeline_id, ok=False, err=err)
        write_audit(
            conn,
            action="timeline.log.failed_post_to_trello",
            target="timeline",
            payload={"timeline_id": timeline_id, "error": err},
            correlation_id=correlation_id,
        )
        return {"ok": False, "timeline_id": timeline_id, "error": err}


# ---------------------------------------------------------------------------
# V2 write_timeline API (writes to timeline_events table)
# ---------------------------------------------------------------------------

def timeline_event_key(event_type: str, primary_card_id: str, suffix: str = "") -> str:
    """Generate a stable event key for idempotency-like behavior."""
    base = f"{event_type}:{primary_card_id}"
    return base if not suffix else f"{base}:{suffix}"


def write_timeline(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str | None,
    primary_card_id: str | None,
    event_type: str,
    title: str,
    human: dict[str, Any],
    machine: dict[str, Any],
    correlation_id: str | None,
    event_key: str | None = None,
) -> dict[str, Any]:
    """Write a timeline event to the timeline_events table.

    This is the V2 API that complements log_timeline_event (which uses
    lifecycle_timeline + posts to Trello). write_timeline is DB-only.
    """
    eid = new_id("evt")
    ek = event_key or timeline_event_key(event_type, primary_card_id or "none")
    conn.execute(
        """INSERT INTO timeline_events
           (event_id, ts, trello_board_id, primary_card_id, event_type, event_key,
            title, human_json, machine_json, correlation_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            eid,
            now_ts(),
            trello_board_id,
            primary_card_id,
            event_type,
            ek,
            title,
            json.dumps(human, separators=(",", ":")),
            json.dumps(machine, separators=(",", ":")),
            correlation_id,
        ),
    )
    conn.commit()

    write_audit(
        conn,
        action="timeline.write",
        target=primary_card_id or eid,
        payload={"event_type": event_type, "event_id": eid},
        correlation_id=correlation_id,
    )
    return {"ok": True, "event_id": eid, "event_key": ek}
