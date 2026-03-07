from __future__ import annotations

import re
import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.integrations.trello.client import TrelloClient

AR_PATTERNS: list[tuple[str, str]] = [
    (r"\b1\s*:\s*1\b|\b1x1\b", "AR: 1:1"),
    (r"\b4\s*:\s*5\b|\b4x5\b", "AR: 4:5"),
    (r"\b9\s*:\s*16\b|\b9x16\b|\bvertical\b", "AR: 9:16"),
    (r"\b16\s*:\s*9\b|\b16x9\b|\bhorizontal\b", "AR: 16:9"),
]


def detect_aspect_ratio_labels(text: str) -> list[str]:
    t = (text or "").lower()
    found = []
    for pattern, label in AR_PATTERNS:
        if re.search(pattern, t, flags=re.IGNORECASE):
            found.append(label)
    return sorted(list(set(found)))


def _ensure_label(tc: TrelloClient, *, board_id: str, name: str, existing: list[dict[str, Any]]) -> str | None:
    for lbl in existing:
        if str(lbl.get("name")) == name:
            return str(lbl.get("id"))
    created = tc.create_label(board_id=board_id, name=name, color="sky")
    return str(created.get("id"))


def apply_aspect_ratio_labels(
    conn: sqlite3.Connection,
    *,
    board_id: str,
    card_id: str,
    text: str,
    correlation_id: str | None,
) -> dict[str, Any]:
    if not settings.TRELLO_AUTO_AR_LABELS:
        return {"ok": True, "skipped": True, "reason": "ar_labels_disabled"}

    labels = detect_aspect_ratio_labels(text)
    if not labels:
        return {"ok": True, "skipped": True, "reason": "no_ar_detected"}

    if settings.DRY_RUN:
        write_audit(
            conn,
            action="trello.ar_labels(dry_run)",
            target=card_id,
            payload={"board_id": board_id, "labels": labels},
            correlation_id=correlation_id,
        )
        return {"ok": True, "mode": "dry_run", "labels": labels}

    tc = TrelloClient()
    existing = tc.get_labels(board_id=board_id)

    applied = []
    for label_name in labels:
        label_id = _ensure_label(tc, board_id=board_id, name=label_name, existing=existing)
        if label_id:
            tc.add_label_to_card(card_id=card_id, label_id=label_id)
            applied.append(label_name)

    write_audit(
        conn,
        action="trello.ar_labels.applied",
        target=card_id,
        payload={"board_id": board_id, "applied": applied},
        correlation_id=correlation_id,
    )
    return {"ok": True, "mode": "live", "applied": applied}
