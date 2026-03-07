from __future__ import annotations

import json
import sqlite3
import time
from typing import Any


def write_offer_intent(
    conn: sqlite3.Connection,
    *,
    correlation_id: str,
    brand: str,
    instagram_handle: str | None,
    email: str | None,
    phone: str | None,
    offer_intent: str,
    budget: str,
    timeline: str,
    raw_answers: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO offer_intents
        (correlation_id, ts, brand, instagram_handle, email, phone, offer_intent, budget, timeline, raw_answers_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            correlation_id,
            int(time.time()),
            brand,
            instagram_handle,
            email,
            phone,
            offer_intent[:500],
            budget[:100],
            timeline[:100],
            json.dumps(raw_answers, ensure_ascii=False),
        ),
    )
    conn.commit()
