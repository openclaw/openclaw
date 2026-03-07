from __future__ import annotations

import os

from fastapi.testclient import TestClient

from services.webhook_gateway.main import app

client = TestClient(app)


def test_ghl_webhook_requires_secret():
    os.environ["GHL_WEBHOOK_SHARED_SECRET"] = "ghl-secret"
    resp = client.post("/webhooks/ghl", json={
        "event_id": "e1",
        "ghl_contact_id": "c1",
        "stage_id": "s1",
        "trello_board_id": "b1",
    })
    assert resp.status_code == 401
