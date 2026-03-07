from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.integrations.trello.client import TrelloClient

CHECKLIST_NAME = "Deliverables"


def ensure_deliverables_checklist(
    conn: sqlite3.Connection,
    *,
    card_id: str,
    deliverables: list[str] | None,
    correlation_id: str | None,
) -> dict[str, Any]:
    """Ensure a Deliverables checklist exists on a card with the given items.

    Idempotent: skips items that already exist by name.
    """
    deliverables = deliverables or []

    if settings.DRY_RUN or settings.SAFE_MODE:
        write_audit(
            conn,
            action="deliverables.ensure.simulated",
            target=card_id,
            payload={"count": len(deliverables)},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run"}

    tc = TrelloClient()
    checklists = tc.get_checklists(card_id=card_id)
    cl = next(
        (c for c in checklists if (c.get("name") or "").strip() == CHECKLIST_NAME),
        None,
    )
    if not cl:
        cl = tc.create_checklist(card_id=card_id, name=CHECKLIST_NAME)

    existing = {(i.get("name") or "").strip() for i in (cl.get("checkItems") or [])}
    for d in deliverables:
        if d.strip() and d.strip() not in existing:
            tc.add_checklist_item(checklist_id=cl["id"], name=d.strip())

    write_audit(
        conn,
        action="deliverables.ensure",
        target=card_id,
        payload={"created": True},
        correlation_id=correlation_id,
    )
    return {"ok": True, "mode": "live", "checklist_id": cl["id"]}
