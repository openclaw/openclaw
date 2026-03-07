from __future__ import annotations

import sqlite3

from packages.agencyu.manychat.ingest import ingest_manychat_event
from packages.common.db import init_schema


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


def test_ingest_dry_run():
    conn = _mem_db()
    result = ingest_manychat_event(
        conn,
        {
            "contact": {
                "id": "mc_001",
                "instagram_username": "@testuser",
                "email": "test@example.com",
                "tags": ["status:qualified", "campaign:scale_guide", "source:meta_ad"],
            },
        },
        correlation_id="corr_001",
    )
    assert result["action"] == "would_ingest_manychat_event"
    assert result["stage"] == "qualified"
    assert result["campaign"] == "scale_guide"


def test_ingest_with_flat_tags():
    conn = _mem_db()
    result = ingest_manychat_event(
        conn,
        {
            "subscriber": {"id": "mc_002"},
            "tags": [{"name": "status:new"}, {"name": "revenue:50k_plus"}],
        },
        correlation_id="corr_002",
    )
    assert result["action"] == "would_ingest_manychat_event"
    assert result["stage"] == "new"


def test_ingest_minimal_payload():
    conn = _mem_db()
    result = ingest_manychat_event(
        conn,
        {},
        correlation_id="corr_003",
    )
    assert result["action"] == "would_ingest_manychat_event"
    assert result["stage"] == "new"
