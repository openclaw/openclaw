from __future__ import annotations

from fastapi.testclient import TestClient

from services.webhook_gateway.main import app

client = TestClient(app)

def test_rejects_missing_secret():
    resp = client.post("/webhooks/manychat", json={"brand": "fulldigital"})
    assert resp.status_code == 401

def test_accepts_valid_secret():
    resp = client.post(
        "/webhooks/manychat",
        headers={"X-Webhook-Secret": "test-secret"},
        json={"brand": "fulldigital", "event_id": "e1", "subscriber_id": "s1"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
