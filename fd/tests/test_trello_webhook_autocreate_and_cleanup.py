from __future__ import annotations

import json
import time

import httpx
import respx
from fastapi.testclient import TestClient

from packages.common.config import settings
from services.webhook_gateway.main import app
from services.webhook_gateway.routes import ops as ops_route_module

client = TestClient(app)


def _seed_active_webhook(conn, board_id: str, webhook_id: str) -> None:
    """Seed directly into the route's module-level _conn."""
    conn.execute(
        """
        INSERT OR REPLACE INTO trello_webhooks
        (trello_webhook_id, trello_board_id, callback_url, is_active, correlation_id, ts)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (webhook_id, board_id, "https://example.com/webhooks/trello?secret=s", 1, "corr", int(time.time())),
    )
    conn.commit()


def _seed_fulfillment_job(conn, board_id: str, primary_card_id: str) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO fulfillment_jobs
        (job_id, ts, brand, correlation_id, ghl_contact_id, customer_email, offer_key, trello_board_id, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"job_{board_id}",
            int(time.time()),
            "fulldigital",
            "corr",
            "ghl_1",
            "client@example.com",
            "fd_rollout_800",
            board_id,
            "created",
            json.dumps({"primary_card_id": primary_card_id, "list_ids": {}}, ensure_ascii=False),
        ),
    )
    conn.commit()


def _clear_idempotency(conn) -> None:
    conn.execute("DELETE FROM idempotency")
    conn.commit()


@respx.mock
def test_ops_cleanup_dry_run(monkeypatch):
    monkeypatch.setattr(settings, "ADMIN_OPS_TOKEN", "admin-secret")
    monkeypatch.setattr(settings, "DRY_RUN", True)

    _clear_idempotency(ops_route_module._conn)
    _seed_active_webhook(ops_route_module._conn, "b1", "wh_1")

    resp = client.post(
        "/ops/trello_webhook_cleanup",
        headers={"X-Admin-Token": "admin-secret"},
        json={"trello_board_id": "b1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["status"] == "cleanup_triggered"
    assert body["cleanup"]["mode"] == "dry_run"


@respx.mock
def test_ops_cleanup_live_moves_card_and_deletes_webhook(monkeypatch):
    monkeypatch.setattr(settings, "ADMIN_OPS_TOKEN", "admin-secret")
    monkeypatch.setattr(settings, "DRY_RUN", False)
    monkeypatch.setattr(settings, "TRELLO_KEY", "tk")
    monkeypatch.setattr(settings, "TRELLO_TOKEN", "tt")
    monkeypatch.setattr(settings, "TRELLO_MOVE_PRIMARY_CARD_ON_CLEANUP", True)
    monkeypatch.setattr(settings, "TRELLO_ARCHIVE_LIST_NAME", "Archived")
    monkeypatch.setattr(settings, "TRELLO_CLOSE_BOARD_ON_CLEANUP", False)

    _clear_idempotency(ops_route_module._conn)
    _seed_active_webhook(ops_route_module._conn, "b2", "wh_2")
    _seed_fulfillment_job(ops_route_module._conn, "b2", "card_primary")

    # GET lists returns list with "Archived"
    respx.get("https://api.trello.com/1/boards/b2/lists").mock(
        return_value=httpx.Response(200, json=[
            {"id": "list_inprog", "name": "In Progress"},
            {"id": "list_arch", "name": "Archived"},
        ])
    )

    # Move card
    respx.put("https://api.trello.com/1/cards/card_primary").mock(
        return_value=httpx.Response(200, json={"id": "card_primary", "idList": "list_arch"})
    )

    # Delete webhook
    respx.delete("https://api.trello.com/1/webhooks/wh_2").mock(
        return_value=httpx.Response(200, json={})
    )

    resp = client.post(
        "/ops/trello_webhook_cleanup",
        headers={"X-Admin-Token": "admin-secret"},
        json={"trello_board_id": "b2"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["status"] == "cleanup_triggered"
    assert body["cleanup"]["mode"] == "live"
    assert body["cleanup"]["primary_card_moved"] is True
    assert body["cleanup"]["primary_card_move_error"] is None
    assert body["cleanup"]["board_closed"] is False
    assert body["cleanup"]["archive_list_name"] == "Archived"
