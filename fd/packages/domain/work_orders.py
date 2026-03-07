from __future__ import annotations

import json
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.clock import now_ts
from packages.common.ids import new_id


def create_or_get_work_order(
    conn: sqlite3.Connection,
    *,
    source: str,
    source_event_id: str,
    correlation_id: str | None,
    request_type: str,
    priority: str,
    client_board_id: str | None,
    client_card_id: str | None,
    ghl_contact_id: str | None,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Idempotent work order creation keyed on source_event_id."""
    row = conn.execute(
        "SELECT * FROM work_orders WHERE source_event_id = ?",
        (source_event_id,),
    ).fetchone()
    if row:
        return {"ok": True, "created": False, "work_order_id": row["work_order_id"]}

    work_order_id = new_id("wo")
    conn.execute(
        """INSERT INTO work_orders
           (work_order_id, ts, source, source_event_id, correlation_id, request_type,
            priority, status, client_board_id, client_card_id, ghl_contact_id, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            work_order_id,
            now_ts(),
            source,
            source_event_id,
            correlation_id,
            request_type,
            priority,
            "new",
            client_board_id,
            client_card_id,
            ghl_contact_id,
            json.dumps(payload, separators=(",", ":")),
        ),
    )
    conn.commit()
    write_audit(
        conn,
        action="work_order.create",
        target=work_order_id,
        payload={"source": source, "source_event_id": source_event_id},
        correlation_id=correlation_id,
    )
    return {"ok": True, "created": True, "work_order_id": work_order_id}


def attach_internal_card(
    conn: sqlite3.Connection,
    *,
    work_order_id: str,
    internal_card_id: str,
    correlation_id: str | None,
) -> None:
    """Attach an internal Trello card to a work order and set status to mirrored."""
    conn.execute(
        "UPDATE work_orders SET internal_card_id=?, status=? WHERE work_order_id=?",
        (internal_card_id, "mirrored", work_order_id),
    )
    conn.commit()
    write_audit(
        conn,
        action="work_order.attach_internal_card",
        target=work_order_id,
        payload={"internal_card_id": internal_card_id},
        correlation_id=correlation_id,
    )


def set_assignment(
    conn: sqlite3.Connection,
    *,
    work_order_id: str,
    assigned_to: str,
    assigned_role: str,
    reason: str,
    correlation_id: str | None,
) -> None:
    """Set assignment on a work order."""
    conn.execute(
        "UPDATE work_orders SET assigned_to=?, assigned_role=?, status=? WHERE work_order_id=?",
        (assigned_to, assigned_role, "assigned", work_order_id),
    )
    conn.commit()
    write_audit(
        conn,
        action="work_order.assign",
        target=work_order_id,
        payload={"assigned_to": assigned_to, "assigned_role": assigned_role, "reason": reason},
        correlation_id=correlation_id,
    )


def get_work_order(conn: sqlite3.Connection, *, work_order_id: str) -> dict[str, Any]:
    """Fetch a work order by ID."""
    row = conn.execute(
        "SELECT * FROM work_orders WHERE work_order_id=?",
        (work_order_id,),
    ).fetchone()
    if not row:
        return {"ok": False, "error": "not_found"}
    return {"ok": True, "row": dict(row)}
