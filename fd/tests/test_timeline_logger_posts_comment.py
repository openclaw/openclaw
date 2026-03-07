from __future__ import annotations

import httpx
import respx

from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.domain.timeline import log_timeline_event


@respx.mock
def test_timeline_posts_comment_live(tmp_path, monkeypatch):
    sqlite_path = str(tmp_path / "app.db")
    monkeypatch.setattr(settings, "SQLITE_PATH", sqlite_path)
    monkeypatch.setattr(settings, "DRY_RUN", False)
    monkeypatch.setattr(settings, "TIMELINE_LOG_ENABLED", True)
    monkeypatch.setattr(settings, "TIMELINE_JSON_MARKER", "[OPENCLAW_JSON]")
    monkeypatch.setattr(settings, "TRELLO_KEY", "tk")
    monkeypatch.setattr(settings, "TRELLO_TOKEN", "tt")

    conn = connect(sqlite_path)
    init_schema(conn)

    # mock comment post
    comment_route = respx.post(
        "https://api.trello.com/1/cards/card_1/actions/comments"
    ).mock(return_value=httpx.Response(200, json={"ok": True}))

    out = log_timeline_event(
        conn,
        trello_board_id="b1",
        primary_card_id="card_1",
        event_type="unit_test",
        event_key="k1",
        title="Unit Test Event",
        human_fields={"Field A": "Value A"},
        machine_fields={"a": 1},
        correlation_id="corr1",
    )
    assert out["ok"] is True
    assert out["mode"] == "live"
    assert comment_route.called

    # Verify timeline row was persisted
    row = conn.execute(
        "SELECT * FROM lifecycle_timeline WHERE timeline_id = ?",
        ("unit_test:k1",),
    ).fetchone()
    assert row is not None
    assert row["posted_to_trello"] == 1
    assert row["post_error"] is None


@respx.mock
def test_timeline_dry_run_skips_post(tmp_path, monkeypatch):
    sqlite_path = str(tmp_path / "app.db")
    monkeypatch.setattr(settings, "SQLITE_PATH", sqlite_path)
    monkeypatch.setattr(settings, "DRY_RUN", True)
    monkeypatch.setattr(settings, "TIMELINE_LOG_ENABLED", True)

    conn = connect(sqlite_path)
    init_schema(conn)

    out = log_timeline_event(
        conn,
        trello_board_id="b1",
        primary_card_id="card_1",
        event_type="unit_test",
        event_key="k2",
        title="Dry Run Event",
        human_fields={"Field A": "Value A"},
        machine_fields={"a": 1},
        correlation_id="corr2",
    )
    assert out["ok"] is True
    assert out["mode"] == "dry_run"

    # Row persisted but not posted
    row = conn.execute(
        "SELECT * FROM lifecycle_timeline WHERE timeline_id = ?",
        ("unit_test:k2",),
    ).fetchone()
    assert row is not None
    assert row["posted_to_trello"] == 0


def test_timeline_disabled_skips(tmp_path, monkeypatch):
    sqlite_path = str(tmp_path / "app.db")
    monkeypatch.setattr(settings, "SQLITE_PATH", sqlite_path)
    monkeypatch.setattr(settings, "TIMELINE_LOG_ENABLED", False)

    conn = connect(sqlite_path)
    init_schema(conn)

    out = log_timeline_event(
        conn,
        trello_board_id="b1",
        primary_card_id="card_1",
        event_type="unit_test",
        event_key="k3",
        title="Disabled Event",
        human_fields={"Field A": "Value A"},
        machine_fields={"a": 1},
    )
    assert out["ok"] is True
    assert out.get("skipped") is True
