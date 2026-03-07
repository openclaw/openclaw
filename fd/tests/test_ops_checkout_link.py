from __future__ import annotations

import os

from fastapi.testclient import TestClient

from services.webhook_gateway.main import app

client = TestClient(app)


def test_ops_requires_admin_token():
    resp = client.post("/ops/create_checkout_link", json={
        "brand": "fulldigital",
        "offer_key": "fd_rollout_800",
        "customer_email": "test@example.com",
    })
    assert resp.status_code == 401


def test_ops_checkout_link_dry_run(monkeypatch):
    os.environ["ADMIN_OPS_TOKEN"] = "admin-secret"
    os.environ["STRIPE_PRICE_ID_FD_ROLLOUT_800"] = "price_test_800"

    resp = client.post(
        "/ops/create_checkout_link",
        headers={"X-Admin-Token": "admin-secret"},
        json={
            "brand": "fulldigital",
            "offer_key": "fd_rollout_800",
            "customer_email": "test@example.com",
            "ghl_contact_id": "ghl_123",
            "correlation_id": "corr_test",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["mode"] == "dry_run"
    assert "dry_run" in body["checkout_url"]
