from __future__ import annotations

import json
import time

import httpx
import respx
from fastapi.testclient import TestClient

from services.webhook_gateway.main import app
from services.webhook_gateway.routes import ghl as ghl_route_module

client = TestClient(app)


def _seed_fulfillment(conn, board_id: str) -> None:
    """Seed directly into the route's module-level _conn."""
    conn.execute(
        """
        INSERT OR REPLACE INTO fulfillment_jobs
        (job_id, ts, brand, correlation_id, ghl_contact_id, customer_email, offer_key, trello_board_id, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "job_resolve_1",
            int(time.time()),
            "fulldigital",
            "corr_abc",
            "ghl_123",
            "client@example.com",
            "fd_rollout_800",
            board_id,
            "created",
            json.dumps({"primary_card_id": "card_1", "list_ids": {}}, ensure_ascii=False),
        ),
    )
    conn.commit()


@respx.mock
def test_ghl_webhook_resolves_board_id_from_contact_custom_field(monkeypatch):
    monkeypatch.setenv("GHL_WEBHOOK_SHARED_SECRET", "ghl-secret")
    monkeypatch.setenv("GHL_BASE_URL", "https://rest.gohighlevel.com")
    monkeypatch.setenv("GHL_API_KEY", "k")
    monkeypatch.setenv("GHL_CUSTOM_FIELD_TRELLO_BOARD_ID_KEY", "TrelloBoardId")
    monkeypatch.setenv("STAGE_TO_TRELLO_LIST_JSON", '{"stage_new":"Awaiting Details"}')
    monkeypatch.setenv("TRELLO_KEY", "tk")
    monkeypatch.setenv("TRELLO_TOKEN", "tt")

    # Seed a fulfillment job into the route's actual DB connection
    _seed_fulfillment(ghl_route_module._conn, "b_resolved")

    # Mock GHL contact fetch to return customField dict
    respx.get("https://rest.gohighlevel.com/v1/contacts/ghl_123").mock(
        return_value=httpx.Response(200, json={"id": "ghl_123", "customField": {"TrelloBoardId": "b_resolved"}})
    )

    # Mock Trello list fetch (route will attempt list lookup since list_ids is empty)
    respx.get("https://api.trello.com/1/boards/b_resolved/lists").mock(
        return_value=httpx.Response(200, json=[{"id": "list_await", "name": "Awaiting Details"}])
    )
    respx.put("https://api.trello.com/1/cards/card_1").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    # DRY_RUN default should log only
    resp = client.post(
        "/webhooks/ghl",
        headers={"X-Webhook-Secret": "ghl-secret"},
        json={
            "event_id": "e_resolve_1",
            "ghl_contact_id": "ghl_123",
            "stage_id": "stage_new",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    # In DRY_RUN, sync should be dry_run_logged
    assert body["sync"] == "dry_run_logged"
