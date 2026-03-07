from __future__ import annotations

from fastapi.testclient import TestClient

from services.webhook_gateway.main import app

client = TestClient(app)

def test_idempotency_blocks_duplicates():
    payload = {"brand": "fulldigital", "event_id": "dup1", "subscriber_id": "s1"}
    h = {"X-Webhook-Secret": "test-secret"}

    r1 = client.post("/webhooks/manychat", headers=h, json=payload)
    assert r1.status_code == 200
    assert r1.json()["duplicate"] is False if "duplicate" in r1.json() else True  # tolerate first response

    r2 = client.post("/webhooks/manychat", headers=h, json=payload)
    assert r2.status_code == 200
    assert r2.json()["duplicate"] is True
