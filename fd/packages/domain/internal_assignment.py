from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.domain.timeline import log_timeline_event
from packages.integrations.trello.client import TrelloClient


def _get_candidates(conn: sqlite3.Connection, role: str) -> list[dict[str, Any]]:
    """Get enabled team_capacity rows whose roles_json includes the given role."""
    cur = conn.execute(
        "SELECT assignee_id, display_name, roles_json, weight, active_jobs FROM team_capacity WHERE enabled = 1",
    )
    results = []
    for row in cur.fetchall():
        try:
            roles = json.loads(row["roles_json"] or "[]")
        except Exception:
            roles = []
        if role in roles:
            results.append(dict(row))
    return results


def _pick_assignee(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick candidate with lowest (active_jobs / weight). Tie-break: assignee_id."""
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c["active_jobs"] / max(c["weight"], 1), c["assignee_id"]))
    return candidates[0]


def assign_work_order(
    conn: sqlite3.Connection,
    *,
    work_order_id: str,
    role: str,
    priority: str,
    internal_card_id: str | None,
    correlation_id: str | None,
    force: bool = False,
) -> dict[str, Any]:
    """Assign a work order to an internal team member via team_capacity.

    Uses work_orders table for state. Optionally mirrors to Trello internal card via label.
    """
    # Check current assignment state
    cur = conn.execute(
        "SELECT assigned_to, status FROM work_orders WHERE work_order_id = ?",
        (work_order_id,),
    )
    row = cur.fetchone()
    if not row:
        return {"ok": False, "error": "work_order_not_found"}

    if row["assigned_to"] and not force:
        return {
            "ok": True,
            "mode": "already_assigned",
            "work_order_id": work_order_id,
            "assigned_to": row["assigned_to"],
        }

    candidates = _get_candidates(conn, role)
    assignee = _pick_assignee(candidates)

    if not assignee:
        write_audit(
            conn,
            action="work_order.assign.no_candidates",
            target=work_order_id,
            payload={"role": role, "priority": priority},
            correlation_id=correlation_id,
        )
        return {"ok": False, "error": "no_candidates_for_role", "role": role}

    assignee_id = assignee["assignee_id"]
    display_name = assignee["display_name"]
    now = int(time.time())

    if settings.DRY_RUN:
        write_audit(
            conn,
            action="work_order.assign(dry_run)",
            target=work_order_id,
            payload={
                "assignee_id": assignee_id,
                "display_name": display_name,
                "role": role,
                "priority": priority,
            },
            correlation_id=correlation_id,
        )
        return {
            "ok": True,
            "mode": "dry_run",
            "work_order_id": work_order_id,
            "assigned_to": assignee_id,
            "display_name": display_name,
            "role": role,
            "priority": priority,
        }

    # Persist assignment in work_orders
    conn.execute(
        """
        UPDATE work_orders
        SET assigned_to = ?, assigned_role = ?, assigned_at = ?, status = 'assigned'
        WHERE work_order_id = ?
        """,
        (assignee_id, role, now, work_order_id),
    )

    # Increment active_jobs for assignee
    conn.execute(
        "UPDATE team_capacity SET active_jobs = active_jobs + 1 WHERE assignee_id = ?",
        (assignee_id,),
    )
    conn.commit()

    write_audit(
        conn,
        action="work_order.assigned",
        target=work_order_id,
        payload={
            "assignee_id": assignee_id,
            "display_name": display_name,
            "role": role,
            "priority": priority,
        },
        correlation_id=correlation_id,
    )

    # Mirror to internal Trello card via label (if card exists)
    if internal_card_id and settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID:
        tc = TrelloClient()
        label_name = f"{settings.ASSIGNMENT_LABEL_PREFIX} {display_name}"

        # Ensure label exists on internal board
        labels = tc.get_labels(board_id=settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID)
        label_id = None
        for lbl in labels:
            if str(lbl.get("name") or "") == label_name:
                label_id = str(lbl.get("id"))
                break
        if not label_id:
            created_lbl = tc.create_label(
                board_id=settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID,
                name=label_name,
                color="blue",
            )
            label_id = str(created_lbl.get("id"))

        tc.add_label_to_card(card_id=internal_card_id, label_id=label_id)

        tc.add_comment_to_card(
            card_id=internal_card_id,
            text=(
                f"Assigned to {display_name}\n\n"
                f"Role: {role}\n"
                f"Priority: {priority}\n\n"
                f"{settings.TIMELINE_JSON_MARKER}\n"
                f'{{"event":"work_order_assigned","assignee":"{assignee_id}","role":"{role}"}}'
            ),
        )

    # Timeline event
    cur2 = conn.execute(
        "SELECT client_board_id FROM work_orders WHERE work_order_id = ?",
        (work_order_id,),
    )
    wo_row = cur2.fetchone()
    if wo_row and wo_row["client_board_id"]:
        log_timeline_event(
            conn,
            trello_board_id=wo_row["client_board_id"],
            event_type="work_order_assigned",
            event_key=work_order_id,
            title="Work Order Assigned",
            human_fields={
                "Assigned To": display_name,
                "Role": role,
                "Priority": priority,
                "Work Order ID": work_order_id,
            },
            machine_fields={
                "work_order_id": work_order_id,
                "assignee_id": assignee_id,
                "display_name": display_name,
                "role": role,
                "priority": priority,
            },
            correlation_id=correlation_id,
        )

    return {
        "ok": True,
        "mode": "live",
        "work_order_id": work_order_id,
        "assigned_to": assignee_id,
        "display_name": display_name,
        "role": role,
        "priority": priority,
    }
