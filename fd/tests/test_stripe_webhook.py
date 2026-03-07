from __future__ import annotations

from fastapi.testclient import TestClient

from services.webhook_gateway.main import app

client = TestClient(app)


def test_stripe_missing_signature_rejected():
    resp = client.post("/webhooks/stripe", data=b"{}")
    assert resp.status_code == 401


def test_stripe_checkout_completed_dry_run(monkeypatch):
    # Monkeypatch StripeClient.verify_webhook_event to bypass real verification
    from packages.integrations.stripe import client as stripe_client_module

    def fake_verify(self, payload_bytes: bytes, sig_header: str):
        return {
            "id": "evt_test_1",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test_1",
                    "amount_total": 80000,
                    "currency": "usd",
                    "customer_details": {"email": "test@example.com"},
                    "metadata": {
                        "ghl_contact_id": "ghl_123",
                        "correlation_id": "corr_abc",
                        "offer_key": "fd_rollout_800",
                        "brand": "fulldigital",
                    },
                }
            },
        }

    monkeypatch.setattr(stripe_client_module.StripeClient, "verify_webhook_event", fake_verify)

    resp = client.post(
        "/webhooks/stripe",
        headers={"Stripe-Signature": "sig_fake"},
        data=b'{"fake":"payload"}',
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["event_id"] == "evt_test_1"
    # DRY_RUN default -> should log won update rather than calling GHL
    assert body["won_update"] == "dry_run_logged"
    assert "fulfillment" in body
    assert body["fulfillment"]["status"] == "dry_run_logged"


def test_stripe_idempotency(monkeypatch):
    from packages.integrations.stripe import client as stripe_client_module

    def fake_verify(self, payload_bytes: bytes, sig_header: str):
        return {
            "id": "evt_test_dup",
            "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_test_dup", "metadata": {}}},
        }

    monkeypatch.setattr(stripe_client_module.StripeClient, "verify_webhook_event", fake_verify)

    h = {"Stripe-Signature": "sig_fake"}
    r1 = client.post("/webhooks/stripe", headers=h, data=b"1")
    assert r1.status_code == 200
    r2 = client.post("/webhooks/stripe", headers=h, data=b"1")
    assert r2.status_code == 200
    assert r2.json().get("duplicate") is True
