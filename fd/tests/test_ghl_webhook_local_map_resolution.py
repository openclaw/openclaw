from __future__ import annotations

import json
import time

import httpx
import respx
from fastapi.testclient import TestClient

from services.webhook_gateway.main import app
from services.webhook_gateway.routes import ghl as ghl_route_module

client = TestClient(app)


def _seed_local_map_and_job(conn, ghl_contact_id: str, board_id: str, primary_card_id: str) -> None:
    """Seed contact_board_map + fulfillment_jobs into the route's module-level _conn."""
    conn.execute(
        """
        INSERT OR REPLACE INTO contact_board_map
        (ghl_contact_id, trello_board_id, primary_card_id, correlation_id, ts)
        VALUES (?, ?, ?, ?, ?)
        """,
        (ghl_contact_id, board_id, primary_card_id, "corr_local", int(time.time())),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO fulfillment_jobs
        (job_id, ts, brand, correlation_id, ghl_contact_id, customer_email, offer_key, trello_board_id, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "job_local_map",
            int(time.time()),
            "fulldigital",
            "corr_local",
            ghl_contact_id,
            "client@example.com",
            "fd_rollout_800",
            board_id,
            "created",
            json.dumps({"primary_card_id": primary_card_id, "list_ids": {}}, ensure_ascii=False),
        ),
    )
    conn.commit()


@respx.mock
def test_ghl_webhook_resolves_from_local_map(monkeypatch):
    monkeypatch.setenv("GHL_WEBHOOK_SHARED_SECRET", "ghl-secret")
    monkeypatch.setenv("STAGE_TO_TRELLO_LIST_JSON", '{"stage_new":"Awaiting Details"}')
    monkeypatch.setenv("TRELLO_KEY", "tk")
    monkeypatch.setenv("TRELLO_TOKEN", "tt")

    # Seed local map + fulfillment into the route's actual DB connection
    _seed_local_map_and_job(ghl_route_module._conn, "ghl_local_map", "b_local", "card_local")

    # Mock Trello list fetch (route may fetch lists if not in metadata)
    respx.get("https://api.trello.com/1/boards/b_local/lists").mock(
        return_value=httpx.Response(200, json=[{"id": "list_await", "name": "Awaiting Details"}])
    )
    respx.put("https://api.trello.com/1/cards/card_local").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    # If local map works, we should NOT need a GHL GET call. Set a trap:
    respx.get("https://rest.gohighlevel.com/v1/contacts/ghl_local_map").mock(
        return_value=httpx.Response(500, json={"error": "should_not_be_called"})
    )

    resp = client.post(
        "/webhooks/ghl",
        headers={"X-Webhook-Secret": "ghl-secret"},
        json={"event_id": "evt_local_map_1", "ghl_contact_id": "ghl_local_map", "stage_id": "stage_new"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["sync"] == "dry_run_logged"
