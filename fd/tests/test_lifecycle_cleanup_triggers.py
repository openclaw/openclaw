from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from packages.common.config import settings
from packages.common.db import init_schema
from services.webhook_gateway.main import app
from services.webhook_gateway.routes import ghl as ghl_route_module
from services.webhook_gateway.routes import trello as trello_route_module

client = TestClient(app)


def _seed(conn, board_id: str, contact_id: str, primary_card_id: str) -> None:
    """Seed fulfillment job + active Trello webhook into the route's module-level _conn."""
    init_schema(conn)
    conn.execute(
        """
        INSERT OR REPLACE INTO fulfillment_jobs
        (job_id, ts, brand, correlation_id, ghl_contact_id, customer_email, offer_key, trello_board_id, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "job1",
            int(time.time()),
            "fulldigital",
            "corr1",
            contact_id,
            "client@example.com",
            "fd_rollout_800",
            board_id,
            "created",
            json.dumps({"primary_card_id": primary_card_id, "list_ids": {}}, ensure_ascii=False),
        ),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO trello_webhooks
        (trello_webhook_id, trello_board_id, callback_url, is_active, correlation_id, ts)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("wh1", board_id, "https://example.com/webhooks/trello?secret=s", 1, "corr1", int(time.time())),
    )
    conn.commit()


def _clear_idempotency(conn) -> None:
    conn.execute("DELETE FROM idempotency")
    conn.commit()


def test_ghl_stage_triggers_cleanup_dry_run(monkeypatch):
    monkeypatch.setattr(settings, "GHL_WEBHOOK_SHARED_SECRET", "ghl-secret")
    monkeypatch.setattr(settings, "CLEANUP_ON_GHL_STAGE_IDS_JSON", '["stage_archived"]')
    monkeypatch.setattr(settings, "TRELLO_CLOSE_BOARD_ON_CLEANUP", False)
    monkeypatch.setattr(settings, "OFFER_CLEANUP_CLOSE_BOARD_JSON", '{"fd_rollout_800": false}')
    monkeypatch.setattr(settings, "DRY_RUN", True)

    _seed(ghl_route_module._conn, "b1", "ghl_123", "card_1")
    _clear_idempotency(ghl_route_module._conn)

    resp = client.post(
        "/webhooks/ghl",
        headers={"X-Webhook-Secret": "ghl-secret"},
        json={"event_id": "e_cleanup_1", "ghl_contact_id": "ghl_123", "stage_id": "stage_archived", "trello_board_id": "b1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sync"] == "cleanup_triggered"
    assert body["cleanup"]["mode"] == "dry_run"


def test_trello_primary_card_to_archived_triggers_cleanup_dry_run(monkeypatch):
    monkeypatch.setattr(settings, "TRELLO_WEBHOOK_SECRET", "trello-secret")
    monkeypatch.setattr(settings, "CLEANUP_ON_TRELLO_LIST_NAMES_JSON", '["Archived"]')
    monkeypatch.setattr(settings, "TRELLO_CLOSE_BOARD_ON_CLEANUP", False)
    monkeypatch.setattr(settings, "OFFER_CLEANUP_CLOSE_BOARD_JSON", '{"fd_rollout_800": false}')
    monkeypatch.setattr(settings, "DRY_RUN", True)

    _seed(trello_route_module._conn, "b2", "ghl_999", "card_primary")
    _clear_idempotency(trello_route_module._conn)

    payload = {
        "model": {"id": "b2"},
        "action": {
            "id": "a_cleanup_1",
            "type": "updateCard",
            "data": {
                "card": {"id": "card_primary", "name": "Production Task(s)"},
                "listBefore": {"name": "In Progress"},
                "listAfter": {"name": "Archived"},
            },
        },
    }

    resp = client.post("/webhooks/trello?secret=trello-secret", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["sync"] == "cleanup_triggered"
    assert body["cleanup"]["mode"] == "dry_run"


def test_trello_board_closed_triggers_cleanup_dry_run(monkeypatch):
    monkeypatch.setattr(settings, "TRELLO_WEBHOOK_SECRET", "trello-secret")
    monkeypatch.setattr(settings, "TRELLO_CLOSE_BOARD_ON_CLEANUP", False)
    monkeypatch.setattr(settings, "OFFER_CLEANUP_CLOSE_BOARD_JSON", '{"fd_rollout_800": false}')
    monkeypatch.setattr(settings, "DRY_RUN", True)

    _seed(trello_route_module._conn, "b3", "ghl_888", "card_x")
    _clear_idempotency(trello_route_module._conn)

    payload = {
        "model": {"id": "b3"},
        "action": {
            "id": "a_close_1",
            "type": "updateBoard",
            "data": {
                "board": {"id": "b3", "closed": True},
            },
        },
    }

    resp = client.post("/webhooks/trello?secret=trello-secret", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["sync"] == "cleanup_triggered"
    assert body["cleanup"]["mode"] == "dry_run"
