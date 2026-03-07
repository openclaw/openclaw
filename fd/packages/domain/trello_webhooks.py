from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.integrations.trello.client import TrelloClient


def create_board_webhook(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str,
    ghl_contact_id: str | None,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Create a Trello webhook for a client board and persist the link."""
    callback = settings.PUBLIC_WEBHOOK_BASE_URL.rstrip("/") + "/webhooks/trello"
    desc = f"OpenClaw Client Board Webhook (board={trello_board_id})"

    if settings.DRY_RUN or settings.SAFE_MODE or not settings.PUBLIC_WEBHOOK_BASE_URL:
        webhook_id = f"dry_webhook_{trello_board_id}"
        _persist(conn, trello_board_id=trello_board_id, ghl_contact_id=ghl_contact_id, trello_webhook_id=webhook_id)
        write_audit(
            conn,
            action="trello.webhook.create.simulated",
            target=trello_board_id,
            payload={"callback": callback},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "webhook_id": webhook_id}

    tc = TrelloClient()
    created = tc.create_webhook(board_id=trello_board_id, callback_url=callback, description=desc)
    webhook_id = created["id"]
    _persist(conn, trello_board_id=trello_board_id, ghl_contact_id=ghl_contact_id, trello_webhook_id=webhook_id)
    write_audit(
        conn,
        action="trello.webhook.create",
        target=trello_board_id,
        payload={"webhook_id": webhook_id, "callback": callback},
        correlation_id=correlation_id,
    )
    return {"ok": True, "mode": "live", "webhook_id": webhook_id}


def _persist(
    conn: sqlite3.Connection,
    *,
    trello_board_id: str,
    ghl_contact_id: str | None,
    trello_webhook_id: str,
) -> None:
    ts = now_ts()
    conn.execute(
        """INSERT INTO trello_board_links
           (trello_board_id, ghl_contact_id, trello_webhook_id, status, created_ts, updated_ts)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(trello_board_id) DO UPDATE SET
             ghl_contact_id=excluded.ghl_contact_id,
             trello_webhook_id=excluded.trello_webhook_id,
             updated_ts=excluded.updated_ts
        """,
        (trello_board_id, ghl_contact_id, trello_webhook_id, "active", ts, ts),
    )
    conn.commit()


def get_board_link(conn: sqlite3.Connection, *, trello_board_id: str) -> dict | None:
    r = conn.execute(
        "SELECT * FROM trello_board_links WHERE trello_board_id=?",
        (trello_board_id,),
    ).fetchone()
    return dict(r) if r else None
