from __future__ import annotations

import os

from fastapi.testclient import TestClient

from services.webhook_gateway.main import app

client = TestClient(app)


def test_trello_verify_requires_secret():
    os.environ["TRELLO_WEBHOOK_SECRET"] = "trello-secret"
    resp = client.get("/webhooks/trello")
    assert resp.status_code == 401


def test_trello_verify_ok():
    os.environ["TRELLO_WEBHOOK_SECRET"] = "trello-secret"
    resp = client.get("/webhooks/trello?secret=trello-secret")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
