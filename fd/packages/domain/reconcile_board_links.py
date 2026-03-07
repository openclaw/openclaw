from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.common.cooldown import is_cooldown_active
from packages.common.job_guard import new_guard
from packages.common.job_runs import record_job_run
from packages.common.logging import get_logger
from packages.domain.dropbox_autoinsert import sync_dropbox_link_to_reference_card
from packages.domain.ghl_contact_index import upsert_contact_index
from packages.domain.trello_lists import CanonicalClientLists, ensure_client_board_schema
from packages.domain.trello_reference_cards import create_reference_cards
from packages.domain.trello_webhooks import create_board_webhook, get_board_link
from packages.domain.welcome_instructions import apply_start_here_and_welcome
from packages.integrations.ghl.client import GHLClient
from packages.integrations.trello.client import TrelloClient

log = get_logger("reconcile")

LIFECYCLE_CARD_NAME = "Account / Lifecycle"


def _read_ghl_board_id(gh: GHLClient, *, contact_id: str) -> str | None:
    if not settings.GHL_TRELLO_BOARD_ID_CUSTOM_FIELD_KEY:
        return None
    mp = gh.get_contact_custom_fields_map(contact_id=contact_id)
    v = mp.get(settings.GHL_TRELLO_BOARD_ID_CUSTOM_FIELD_KEY)
    return v.strip() if isinstance(v, str) and v.strip() else None


def _get_board_links_row(conn: sqlite3.Connection, *, trello_board_id: str) -> dict[str, Any] | None:
    r = conn.execute(
        "SELECT * FROM trello_board_links WHERE trello_board_id=?",
        (trello_board_id,),
    ).fetchone()
    return dict(r) if r else None


def _set_lifecycle_card_id(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str,
    lifecycle_card_id: str,
) -> None:
    conn.execute(
        "UPDATE trello_board_links SET lifecycle_card_id=?, updated_ts=? WHERE trello_board_id=?",
        (lifecycle_card_id, now_ts(), trello_board_id),
    )
    conn.commit()


def _ensure_lifecycle_card(
    conn: sqlite3.Connection,
    *,
    tc: TrelloClient,
    trello_board_id: str,
    ghl_contact_id: str,
    client_name: str,
    correlation_id: str | None,
) -> tuple[str | None, dict[str, Any]]:
    """Ensures canonical lists exist and lifecycle card exists.

    Returns (lifecycle_card_id, action_dict).
    """
    mapping = ensure_client_board_schema(trello_board_id, tc)
    inbox_list_id = mapping[CanonicalClientLists().requests]

    # Try existing lifecycle card id from DB
    link = _get_board_links_row(conn, trello_board_id=trello_board_id)
    if link and link.get("lifecycle_card_id"):
        return link["lifecycle_card_id"], {"action": "lifecycle.exists", "card_id": link["lifecycle_card_id"]}

    # Find by name on the inbox list
    if settings.DRY_RUN or settings.SAFE_MODE:
        return None, {"action": "would_create_or_find_lifecycle", "board_id": trello_board_id}

    # Live: search cards in inbox list for name match
    cards = tc.get_cards_in_list(list_id=inbox_list_id)
    found = None
    for c in cards:
        if (c.get("name") or "").strip() == LIFECYCLE_CARD_NAME:
            found = c
            break

    if found:
        _set_lifecycle_card_id(conn, trello_board_id=trello_board_id, lifecycle_card_id=found["id"])
        return found["id"], {"action": "lifecycle.found_by_name", "card_id": found["id"]}

    # Create lifecycle card
    lifecycle_desc = (
        "This card represents the client lifecycle stage.\n"
        "Do not use it for requests.\n\n"
        "JSON:\n"
        f'{{"type":"lifecycle","ghl_contact_id":"{ghl_contact_id}"}}'
    )
    created = tc.create_card(list_id=inbox_list_id, name=LIFECYCLE_CARD_NAME, desc=lifecycle_desc)
    _set_lifecycle_card_id(conn, trello_board_id=trello_board_id, lifecycle_card_id=created["id"])
    return created["id"], {"action": "lifecycle.created", "card_id": created["id"]}


def reconcile_board_links(
    conn: sqlite3.Connection,
    *,
    limit: int = 200,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Repairs:
      - mapping drift between local index and GHL custom field board_id
      - missing trello_board_links rows
      - missing webhook id (creates/simulates)
    Heals:
      - canonical board lists schema
      - reference template cards
      - lifecycle card + stores lifecycle_card_id
      - dropbox auto insert into Dropbox reference card
      - start-here + welcome comment (if lifecycle available)
    Safe behavior:
      - DRY_RUN or SAFE_MODE never mutates external services; reports would_* actions
      - mismatched board_id is flagged, not overwritten automatically
    """
    started_ts = datetime.now(tz=UTC).isoformat()

    # Circuit breaker: skip if cooldown active
    if is_cooldown_active(conn):
        write_audit(
            conn,
            action="reconcile_board_links.skipped.cooldown_active",
            target="system",
            payload={},
            correlation_id=correlation_id,
        )
        record_job_run(
            conn, job_name="reconcile_board_links", status="skipped", stop_reason="cooldown_active",
            started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
            stats={}, correlation_id=correlation_id,
        )
        return {"ok": True, "skipped": True, "reason": "cooldown_active"}

    actions: list[dict[str, Any]] = []
    guard = new_guard("reconcile_board_links")
    cur = conn.execute(
        "SELECT * FROM ghl_contact_index ORDER BY updated_ts DESC LIMIT ?",
        (min(limit, settings.JOB_BATCH_LIMIT * 2),),
    )
    rows = [dict(r) for r in cur.fetchall()]

    gh = GHLClient() if (settings.GHL_API_KEY and settings.GHL_LOCATION_ID) else None
    tc = TrelloClient() if (not settings.DRY_RUN and not settings.SAFE_MODE) else None

    for r in rows:
        stop_reason = guard.should_stop()
        if stop_reason:
            write_audit(
                conn,
                action="reconcile_board_links.stopped.guard",
                target="system",
                payload={"reason": stop_reason, **guard.snapshot()},
                correlation_id=correlation_id,
            )
            record_job_run(
                conn, job_name="reconcile_board_links", status="stopped", stop_reason=stop_reason,
                started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
                stats=guard.snapshot(), correlation_id=correlation_id,
            )
            return {"ok": True, "stopped": True, "reason": stop_reason, "stats": guard.snapshot(), "actions": actions}
        contact_id = r["ghl_contact_id"]
        email = r.get("email")
        phone = r.get("phone")
        local_board = r.get("trello_board_id")
        local_webhook = r.get("trello_webhook_id")

        if gh:
            guard.mark_read()
        ghl_board = _read_ghl_board_id(gh, contact_id=contact_id) if gh else None

        # --- Mapping repairs ---
        if ghl_board and not local_board:
            upsert_contact_index(
                conn,
                ghl_contact_id=contact_id,
                email=email,
                phone=phone,
                trello_board_id=ghl_board,
                trello_webhook_id=local_webhook,
            )
            local_board = ghl_board
            actions.append({"contact": contact_id, "action": "adopt_ghl_board_to_local", "board_id": ghl_board})

        if local_board and gh and settings.GHL_TRELLO_BOARD_ID_CUSTOM_FIELD_KEY and not ghl_board:
            if settings.DRY_RUN or settings.SAFE_MODE:
                actions.append({"contact": contact_id, "action": "would_write_local_board_to_ghl", "board_id": local_board})
            else:
                guard.mark_write()
                gh.update_contact_custom_fields(
                    contact_id=contact_id,
                    custom_fields={settings.GHL_TRELLO_BOARD_ID_CUSTOM_FIELD_KEY: local_board},
                )
                actions.append({"contact": contact_id, "action": "wrote_local_board_to_ghl", "board_id": local_board})

        if ghl_board and local_board and ghl_board != local_board:
            actions.append({"contact": contact_id, "action": "mismatch_flagged", "local": local_board, "ghl": ghl_board})
            # do not heal further if mismatch; we don't know which board is correct
            continue

        # If still no board, nothing to heal.
        if not local_board:
            continue

        # Ensure trello_board_links row exists
        link = get_board_link(conn, trello_board_id=local_board)
        if not link:
            ts = now_ts()
            conn.execute(
                """INSERT INTO trello_board_links
                   (trello_board_id, ghl_contact_id, trello_webhook_id,
                    status, created_ts, updated_ts)
                   VALUES (?,?,?,?,?,?)""",
                (local_board, contact_id, local_webhook, "active", ts, ts),
            )
            conn.commit()
            actions.append({"contact": contact_id, "action": "repaired_board_links_row", "board_id": local_board})
            link = get_board_link(conn, trello_board_id=local_board)

        # Ensure webhook exists (optional)
        if not local_webhook and settings.PUBLIC_WEBHOOK_BASE_URL:
            guard.mark_write()
            wh = create_board_webhook(
                conn,
                trello_board_id=local_board,
                ghl_contact_id=contact_id,
                correlation_id=correlation_id,
            )
            upsert_contact_index(
                conn,
                ghl_contact_id=contact_id,
                email=email,
                phone=phone,
                trello_board_id=local_board,
                trello_webhook_id=wh.get("webhook_id"),
            )
            local_webhook = wh.get("webhook_id")
            actions.append({"contact": contact_id, "action": "webhook_created_or_simulated", "board_id": local_board, "webhook_id": local_webhook})

        # --- Healing steps ---
        client_name = email or f"Client {contact_id}"

        # A) Ensure canonical lists schema
        if settings.DRY_RUN or settings.SAFE_MODE:
            actions.append({"contact": contact_id, "action": "would_ensure_board_schema", "board_id": local_board})
        else:
            try:
                guard.mark_read()
                ensure_client_board_schema(local_board, tc)  # idempotent
                actions.append({"contact": contact_id, "action": "ensured_board_schema", "board_id": local_board})
            except Exception:
                guard.mark_error()
                log.warning(f"Failed to ensure board schema for board {local_board}")

        # B) Ensure reference template cards exist
        try:
            guard.mark_write()
            ref_res = create_reference_cards(
                conn,
                trello_board_id=local_board,
                correlation_id=correlation_id,
            )
            actions.append({"contact": contact_id, "action": "reference_cards", "board_id": local_board, "result": ref_res})
        except Exception:
            guard.mark_error()
            log.warning(f"Failed to ensure reference cards for board {local_board}")

        # C) Ensure lifecycle card exists + persist lifecycle_card_id
        lifecycle_card_id = None
        if settings.DRY_RUN or settings.SAFE_MODE:
            actions.append({"contact": contact_id, "action": "would_ensure_lifecycle_card", "board_id": local_board})
        else:
            try:
                guard.mark_write()
                lifecycle_card_id, lifecycle_action = _ensure_lifecycle_card(
                    conn,
                    tc=tc,
                    trello_board_id=local_board,
                    ghl_contact_id=contact_id,
                    client_name=client_name,
                    correlation_id=correlation_id,
                )
                actions.append({"contact": contact_id, **lifecycle_action, "board_id": local_board})
            except Exception:
                guard.mark_error()
                log.warning(f"Failed to ensure lifecycle card for board {local_board}")

        # D) Dropbox auto insert (safe-aware)
        try:
            dbx_res = sync_dropbox_link_to_reference_card(
                conn,
                board_id=local_board,
                ghl_contact_id=contact_id,
                client_name=client_name,
                correlation_id=correlation_id,
            )
            actions.append({"contact": contact_id, "action": "dropbox_autoinsert", "board_id": local_board, "result": dbx_res})
        except Exception:
            guard.mark_error()
            log.warning(f"Failed to sync Dropbox link for board {local_board}")

        # E) START HERE pinned + welcome comment (only if lifecycle exists)
        if lifecycle_card_id:
            try:
                guard.mark_write()
                welcome_res = apply_start_here_and_welcome(
                    conn,
                    board_id=local_board,
                    lifecycle_card_id=lifecycle_card_id,
                    client_name=client_name,
                    ghl_contact_id=contact_id,
                    correlation_id=correlation_id,
                )
                actions.append({"contact": contact_id, "action": "welcome_start_here", "board_id": local_board, "result": welcome_res})
            except Exception:
                guard.mark_error()
                log.warning(f"Failed to apply welcome/start-here for board {local_board}")
        else:
            actions.append({"contact": contact_id, "action": "welcome_start_here_skipped", "board_id": local_board, "reason": "no_lifecycle_card_id"})

        guard.mark_processed()

    write_audit(
        conn,
        action="admin.reconcile_board_links.heal",
        target="system",
        payload={"count": len(actions), **guard.snapshot()},
        correlation_id=correlation_id,
    )
    record_job_run(
        conn, job_name="reconcile_board_links", status="success", stop_reason=None,
        started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
        stats=guard.snapshot(), correlation_id=correlation_id,
    )
    return {"ok": True, "actions": actions, "count": len(actions), "stats": guard.snapshot()}
