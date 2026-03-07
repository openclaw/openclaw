from __future__ import annotations

import sqlite3

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.config import settings
from packages.integrations.ghl.client import GHLClient


def upsert_contact_index(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str,
    email: str | None,
    phone: str | None,
    trello_board_id: str | None,
    trello_webhook_id: str | None,
) -> None:
    """Insert or update the GHL contact → Trello board index."""
    ts = now_ts()
    conn.execute(
        """INSERT INTO ghl_contact_index
           (ghl_contact_id, email, phone, trello_board_id, trello_webhook_id, updated_ts)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(ghl_contact_id) DO UPDATE SET
             email=excluded.email,
             phone=excluded.phone,
             trello_board_id=excluded.trello_board_id,
             trello_webhook_id=excluded.trello_webhook_id,
             updated_ts=excluded.updated_ts
        """,
        (ghl_contact_id, email, phone, trello_board_id, trello_webhook_id, ts),
    )
    conn.commit()


def get_index_by_contact(conn: sqlite3.Connection, *, ghl_contact_id: str) -> dict | None:
    r = conn.execute(
        "SELECT * FROM ghl_contact_index WHERE ghl_contact_id=?",
        (ghl_contact_id,),
    ).fetchone()
    return dict(r) if r else None


def get_index_by_board(conn: sqlite3.Connection, *, trello_board_id: str) -> dict | None:
    r = conn.execute(
        "SELECT * FROM ghl_contact_index WHERE trello_board_id=?",
        (trello_board_id,),
    ).fetchone()
    return dict(r) if r else None


def resolve_ghl_contact_id(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str | None,
    email: str | None,
    phone: str | None,
    trello_board_id: str | None,
    correlation_id: str | None,
) -> str | None:
    """Resolution chain: direct → by board → by email/phone in index → live GHL search."""
    # 1) Direct
    if ghl_contact_id:
        return ghl_contact_id

    # 2) By board ID (fast local lookup)
    if trello_board_id:
        row = get_index_by_board(conn, trello_board_id=trello_board_id)
        if row and row.get("ghl_contact_id"):
            return row["ghl_contact_id"]

    # 3) By email/phone in local index
    if email:
        r = conn.execute(
            "SELECT ghl_contact_id FROM ghl_contact_index WHERE email=?",
            (email,),
        ).fetchone()
        if r:
            return r["ghl_contact_id"]
    if phone:
        r = conn.execute(
            "SELECT ghl_contact_id FROM ghl_contact_index WHERE phone=?",
            (phone,),
        ).fetchone()
        if r:
            return r["ghl_contact_id"]

    # 4) Live search in GHL (if configured)
    if settings.GHL_API_KEY and settings.GHL_LOCATION_ID:
        gh = GHLClient()
        contacts = gh.search_contacts(email=email, phone=phone, limit=5)
        if contacts:
            cid = contacts[0].get("id") or contacts[0].get("contactId")
            if cid:
                write_audit(
                    conn,
                    action="ghl.resolve.found",
                    target=cid,
                    payload={"email": email, "phone": phone},
                    correlation_id=correlation_id,
                )
                return cid

    return None
