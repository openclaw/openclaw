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


def _seed(conn, board_id: str, primary_card_id: str) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO fulfillment_jobs
        (job_id, ts, brand, correlation_id, ghl_contact_id,
         customer_email, offer_key, trello_board_id, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"job_{board_id}",
            int(time.time()),
            "fulldigital",
            "corr1",
            "ghl_1",
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
        (
            f"wh_{board_id}", board_id,
            "https://example.com/webhooks/trello?secret=s",
            1, "corr1", int(time.time()),
        ),
    )
    conn.commit()


def _clear_idempotency(conn) -> None:
    conn.execute("DELETE FROM idempotency")
    conn.commit()


@respx.mock
def test_live_cleanup_autocreates_label_and_applies(monkeypatch):
    monkeypatch.setattr(settings, "ADMIN_OPS_TOKEN", "admin-secret")
    monkeypatch.setattr(settings, "DRY_RUN", False)
    monkeypatch.setattr(settings, "TRELLO_KEY", "tk")
    monkeypatch.setattr(settings, "TRELLO_TOKEN", "tt")

    monkeypatch.setattr(settings, "TRELLO_CLOSE_BOARD_ON_CLEANUP", False)
    monkeypatch.setattr(settings, "TRELLO_MOVE_PRIMARY_CARD_ON_CLEANUP", True)
    monkeypatch.setattr(settings, "TRELLO_ARCHIVE_LIST_NAME", "Archived")
    monkeypatch.setattr(settings, "TRELLO_AUTOCREATE_ARCHIVE_LIST_ON_CLEANUP", True)

    monkeypatch.setattr(settings, "TRELLO_APPLY_ARCHIVED_LABEL_ON_CLEANUP", True)
    monkeypatch.setattr(settings, "TRELLO_AUTOCREATE_ARCHIVED_LABEL_ON_CLEANUP", True)
    monkeypatch.setattr(settings, "TRELLO_ARCHIVED_LABEL_NAME", "Archived")

    _clear_idempotency(ops_route_module._conn)
    _seed(ops_route_module._conn, "b_lbl", "card_1")

    # Lists: Archived missing, will create list
    respx.get("https://api.trello.com/1/boards/b_lbl/lists").mock(
        return_value=httpx.Response(200, json=[{"id": "list_inprog", "name": "In Progress"}])
    )
    respx.post("https://api.trello.com/1/lists").mock(
        return_value=httpx.Response(200, json={"id": "list_arch", "name": "Archived"})
    )
    respx.put("https://api.trello.com/1/cards/card_1").mock(
        return_value=httpx.Response(200, json={"id": "card_1", "idList": "list_arch"})
    )

    # Labels: Archived missing, will create label then apply
    respx.get("https://api.trello.com/1/boards/b_lbl/labels").mock(
        return_value=httpx.Response(200, json=[{"id": "lbl_other", "name": "Hot"}])
    )
    respx.post("https://api.trello.com/1/labels").mock(
        return_value=httpx.Response(
            200, json={"id": "lbl_arch", "name": "Archived", "color": "yellow"},
        )
    )
    respx.post("https://api.trello.com/1/cards/card_1/idLabels").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    # Delete webhook
    respx.delete("https://api.trello.com/1/webhooks/wh_b_lbl").mock(
        return_value=httpx.Response(200, json={})
    )

    resp = client.post(
        "/ops/trello_webhook_cleanup",
        headers={"X-Admin-Token": "admin-secret"},
        json={"trello_board_id": "b_lbl"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["cleanup"]["mode"] == "live"
    assert body["cleanup"]["primary_card_moved"] is True
    assert body["cleanup"]["archived_label_applied"] is True
    assert body["cleanup"]["archived_label_error"] is None
    assert body["cleanup"]["board_closed"] is False
