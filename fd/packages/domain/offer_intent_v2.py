from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.ids import new_id

# ---------------------------------------------------------------------------
# V2 offer intent module for Stripe checkout flow.
# Uses checkout_offer_intents table (separate from ManyChat offer_intents).
# ---------------------------------------------------------------------------

_TABLE = "checkout_offer_intents"


def create_offer_intent(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str | None,
    email: str | None,
    phone: str | None,
    offer_code: str,
    amount_cents: int,
    currency: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    oid = new_id("offer")
    ts = now_ts()
    conn.execute(
        f"""INSERT INTO {_TABLE}
           (offer_intent_id, status, ghl_contact_id, email, phone, offer_code,
            amount_cents, currency, correlation_id, created_ts, updated_ts)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (oid, "created", ghl_contact_id, email, phone, offer_code, amount_cents, currency, correlation_id, ts, ts),
    )
    conn.commit()
    write_audit(
        conn,
        action="offer_intent.create",
        target=oid,
        payload={"offer_code": offer_code, "amount_cents": amount_cents},
        correlation_id=correlation_id,
    )
    return {"ok": True, "offer_intent_id": oid}


def set_offer_intent_stripe_session(
    conn: sqlite3.Connection,
    *,
    offer_intent_id: str,
    stripe_checkout_session_id: str,
    correlation_id: str | None,
) -> None:
    conn.execute(
        f"UPDATE {_TABLE} SET stripe_checkout_session_id=?, status=?, updated_ts=? WHERE offer_intent_id=?",
        (stripe_checkout_session_id, "checkout_created", now_ts(), offer_intent_id),
    )
    conn.commit()
    write_audit(
        conn,
        action="offer_intent.attach_session",
        target=offer_intent_id,
        payload={"session": stripe_checkout_session_id},
        correlation_id=correlation_id,
    )


def mark_offer_intent_paid(
    conn: sqlite3.Connection,
    *,
    offer_intent_id: str,
    stripe_payment_intent_id: str | None,
    correlation_id: str | None,
) -> None:
    conn.execute(
        f"UPDATE {_TABLE} SET stripe_payment_intent_id=?, status=?, updated_ts=? WHERE offer_intent_id=?",
        (stripe_payment_intent_id, "paid", now_ts(), offer_intent_id),
    )
    conn.commit()
    write_audit(
        conn,
        action="offer_intent.paid",
        target=offer_intent_id,
        payload={"payment_intent": stripe_payment_intent_id},
        correlation_id=correlation_id,
    )


def attach_offer_intent_board(
    conn: sqlite3.Connection,
    *,
    offer_intent_id: str,
    trello_board_id: str,
    correlation_id: str | None,
) -> None:
    conn.execute(
        f"UPDATE {_TABLE} SET trello_board_id=?, status=?, updated_ts=? WHERE offer_intent_id=?",
        (trello_board_id, "board_provisioned", now_ts(), offer_intent_id),
    )
    conn.commit()
    write_audit(
        conn,
        action="offer_intent.attach_board",
        target=offer_intent_id,
        payload={"trello_board_id": trello_board_id},
        correlation_id=correlation_id,
    )


def get_offer_intent_by_session(conn: sqlite3.Connection, *, session_id: str) -> dict | None:
    r = conn.execute(
        f"SELECT * FROM {_TABLE} WHERE stripe_checkout_session_id=?",
        (session_id,),
    ).fetchone()
    return dict(r) if r else None


def get_offer_intent(conn: sqlite3.Connection, *, offer_intent_id: str) -> dict | None:
    r = conn.execute(
        f"SELECT * FROM {_TABLE} WHERE offer_intent_id=?",
        (offer_intent_id,),
    ).fetchone()
    return dict(r) if r else None
