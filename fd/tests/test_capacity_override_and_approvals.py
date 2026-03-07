"""Tests for capacity override, approval engine (two-step), signed callbacks, and Telegram bot."""
from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

# ── Helpers ──


def _make_conn() -> sqlite3.Connection:
    """Create an in-memory SQLite DB with all required tables."""
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE system_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE capacity_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            brand TEXT NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            total_hours REAL NOT NULL DEFAULT 0,
            committed_hours REAL NOT NULL DEFAULT 0,
            free_hours REAL NOT NULL DEFAULT 0,
            headroom_ratio REAL NOT NULL DEFAULT 0,
            computed_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE audit_log (
            id TEXT PRIMARY KEY,
            ts INTEGER,
            action TEXT,
            target TEXT,
            correlation_id TEXT,
            payload_json TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE approvals_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            approval_id TEXT NOT NULL UNIQUE,
            action_type TEXT NOT NULL,
            brand TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            risk_level TEXT NOT NULL,
            summary TEXT NOT NULL,
            correlation_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            requested_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            decided_at TEXT,
            decided_by TEXT,
            decision_note TEXT,
            step INTEGER NOT NULL DEFAULT 1,
            requires_two_step INTEGER NOT NULL DEFAULT 0,
            confirm_expires_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE callback_nonces (
            nonce TEXT PRIMARY KEY,
            approval_id TEXT NOT NULL,
            action TEXT NOT NULL,
            created_at TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def _insert_capacity(conn, brand, headroom, free_hours):
    now = datetime.now(UTC).isoformat()
    conn.execute(
        """INSERT INTO capacity_state
           (brand, period_start, period_end, total_hours, committed_hours,
            free_hours, headroom_ratio, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (brand, now, now, 100, 100 - free_hours, free_hours, headroom, now),
    )
    conn.commit()


TWO_STEP_POLICY = {
    "approvals": {
        "enabled": True,
        "default_mode": "require",
        "budget_delta_approval_usd": 25,
        "max_daily_spend_hard_cap_usd": 200,
        "two_step": {
            "enabled": True,
            "confirm_ttl_minutes": 10,
            "triggers": [
                {"type": "risk_level", "value": "high"},
                {"type": "meta.absolute_daily_budget_gte", "value": 200},
                {"type": "compound_action", "value": "meta.launch_campaign+meta.increase_budget"},
            ],
        },
        "actions_require_approval": [
            "meta.launch_campaign",
            "meta.increase_budget",
            "meta.enable_adset",
        ],
        "safe_actions_auto_allowed": [
            "meta.pause_adset",
            "meta.decrease_budget",
        ],
    }
}


# ══════════════════════════════════════════
# 1. Capacity Override Tests
# ══════════════════════════════════════════


class TestCapacityOverride:
    """Test _override_allows_scale and capacity_ok_to_scale with override."""

    def test_override_off(self):
        from packages.agencyu.operations.capacity_gate import _override_allows_scale

        conn = _make_conn()
        ok, msg, meta = _override_allows_scale(conn)
        assert ok is False

    def test_override_on_but_no_expires(self):
        from packages.agencyu.operations.capacity_gate import _override_allows_scale

        conn = _make_conn()
        conn.execute(
            "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("capacity_override_ok_to_scale", "true", "2025-01-01"),
        )
        conn.commit()

        ok, msg, meta = _override_allows_scale(conn)
        assert ok is False
        assert "missing" in msg.lower()

    def test_override_on_expired(self):
        from packages.agencyu.operations.capacity_gate import _override_allows_scale

        conn = _make_conn()
        past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_ok_to_scale", "true", "2025-01-01"))
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_expires_at", past, "2025-01-01"))
        conn.commit()

        ok, msg, meta = _override_allows_scale(conn)
        assert ok is False
        assert "expired" in msg.lower()

    def test_override_on_active(self):
        from packages.agencyu.operations.capacity_gate import _override_allows_scale

        conn = _make_conn()
        future = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_ok_to_scale", "true", "2025-01-01"))
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_expires_at", future, "2025-01-01"))
        conn.commit()

        ok, msg, meta = _override_allows_scale(conn)
        assert ok is True
        assert "active" in msg.lower()

    def test_capacity_ok_to_scale_uses_override_for_fulldigital(self):
        from packages.agencyu.operations.capacity_gate import capacity_ok_to_scale

        conn = _make_conn()
        future = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_ok_to_scale", "true", "2025-01-01"))
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_expires_at", future, "2025-01-01"))
        conn.commit()

        policy = {"capacity_gate": {"enabled": True, "brand_overrides": {"fulldigital": {"enabled": True}}}}
        ok, msg, data = capacity_ok_to_scale(conn, "fulldigital", policy)
        assert ok is True
        assert "override" in msg.lower()

    def test_override_not_used_for_cutmv(self):
        from packages.agencyu.operations.capacity_gate import capacity_ok_to_scale

        conn = _make_conn()
        future = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_ok_to_scale", "true", "2025-01-01"))
        conn.execute("INSERT INTO system_settings VALUES (?, ?, ?)", ("capacity_override_expires_at", future, "2025-01-01"))
        conn.commit()

        policy = {"capacity_gate": {"enabled": True, "brand_overrides": {"cutmv": {"enabled": False}}}}
        ok, msg, data = capacity_ok_to_scale(conn, "cutmv", policy)
        assert ok is True
        assert "override" not in msg.lower()

    def test_capacity_gate_blocks_without_override(self):
        from packages.agencyu.operations.capacity_gate import capacity_ok_to_scale

        conn = _make_conn()
        _insert_capacity(conn, "fulldigital", headroom=0.05, free_hours=2)
        policy = {
            "capacity_gate": {
                "enabled": True, "min_headroom_ratio_to_scale": 0.20,
                "min_free_hours_to_scale": 10,
                "brand_overrides": {"fulldigital": {"enabled": True}},
            }
        }
        ok, msg, data = capacity_ok_to_scale(conn, "fulldigital", policy)
        assert ok is False


# ══════════════════════════════════════════
# 2. Approval Engine — Single-Step Tests
# ══════════════════════════════════════════


class TestApprovalEngineSingleStep:

    def _engine(self, conn=None, policy=None):
        from packages.agencyu.approvals.engine import ApprovalEngine

        if conn is None:
            conn = _make_conn()
        if policy is None:
            policy = {
                "approvals": {
                    "enabled": True,
                    "default_mode": "require",
                    "budget_delta_approval_usd": 25,
                    "actions_require_approval": ["meta.launch_campaign", "meta.increase_budget"],
                    "safe_actions_auto_allowed": ["meta.pause_adset", "meta.decrease_budget"],
                }
            }
        return ApprovalEngine(conn=conn, policy=policy, signing_secret="test-secret"), conn

    def test_requires_approval_for_campaign_launch(self):
        engine, _ = self._engine()
        assert engine.requires_approval("meta.launch_campaign") is True

    def test_safe_action_auto_allowed(self):
        engine, _ = self._engine()
        assert engine.requires_approval("meta.pause_adset") is False

    def test_disabled_approvals(self):
        engine, _ = self._engine(policy={"approvals": {"enabled": False}})
        assert engine.requires_approval("meta.launch_campaign") is False

    def test_request_and_approve_single_step(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"campaign_name": "test"}, "Launch test", "corr_1",
        )
        assert result["requires_two_step"] is False

        decision = engine.approve_step1(result["approval_id"], "user:test")
        assert decision["status"] == "APPROVED"

    def test_request_and_deny(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital", {}, "Test", "corr_2",
        )
        decision = engine.deny(result["approval_id"], "user:test", note="nope")
        assert decision["status"] == "DENIED"

    def test_double_decide_is_noop(self):
        engine, conn = self._engine()
        result = engine.request_approval("meta.launch_campaign", "fulldigital", {}, "Test", "corr_3")
        engine.approve_step1(result["approval_id"], "user:1")
        second = engine.deny(result["approval_id"], "user:2")
        assert second["status"] == "NOOP"

    def test_get_pending(self):
        engine, conn = self._engine()
        engine.request_approval("meta.launch_campaign", "fulldigital", {}, "A", "c1")
        engine.request_approval("meta.increase_budget", "fulldigital", {}, "B", "c2")
        pending = engine.get_pending()
        assert len(pending) == 2

    def test_legacy_decide_routes_correctly(self):
        engine, conn = self._engine()
        result = engine.request_approval("meta.launch_campaign", "fulldigital", {}, "Test", "c1")
        decision = engine.decide(result["approval_id"], True, "user:1")
        assert decision["status"] == "APPROVED"

        result2 = engine.request_approval("meta.launch_campaign", "fulldigital", {}, "Test2", "c2")
        decision2 = engine.decide(result2["approval_id"], False, "user:1")
        assert decision2["status"] == "DENIED"


# ══════════════════════════════════════════
# 3. Approval Engine — Two-Step Tests
# ══════════════════════════════════════════


class TestApprovalEngineTwoStep:

    def _engine(self, conn=None):
        from packages.agencyu.approvals.engine import ApprovalEngine

        if conn is None:
            conn = _make_conn()
        return ApprovalEngine(conn=conn, policy=TWO_STEP_POLICY, signing_secret="test-secret"), conn

    def test_two_step_required_for_high_risk(self):
        engine, _ = self._engine()
        assert engine._two_step_required("meta.launch_campaign", {"risk_level": "high"}) is True

    def test_two_step_not_required_for_medium_risk(self):
        engine, _ = self._engine()
        assert engine._two_step_required("meta.launch_campaign", {"risk_level": "medium"}) is False

    def test_two_step_required_for_high_budget(self):
        engine, _ = self._engine()
        assert engine._two_step_required("meta.increase_budget", {"absolute_daily_budget_usd": 250}) is True

    def test_two_step_required_for_compound_action(self):
        engine, _ = self._engine()
        assert engine._two_step_required("meta.launch_campaign", {
            "compound_action_key": "meta.launch_campaign+meta.increase_budget",
        }) is True

    def test_two_step_flow_approve_step1_then_final(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "High-risk campaign", "corr_ts1",
        )
        assert result["requires_two_step"] is True
        assert result["confirm_expires_at"] is not None

        step1 = engine.approve_step1(result["approval_id"], "user:test")
        assert step1["status"] == "APPROVED_STEP1"
        assert "confirm_expires_at" in step1

        # Executor can't run yet
        status = engine.get_status(result["approval_id"])
        assert status["status"] == "APPROVED_STEP1"

        final = engine.approve_final(result["approval_id"], "user:test")
        assert final["status"] == "APPROVED"

    def test_two_step_deny_from_step1(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "High-risk campaign", "corr_ts2",
        )
        engine.approve_step1(result["approval_id"], "user:test")
        denial = engine.deny(result["approval_id"], "user:test", note="changed my mind")
        assert denial["status"] == "DENIED"

    def test_two_step_deny_from_pending(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "Test", "corr_ts3",
        )
        denial = engine.deny(result["approval_id"], "user:test")
        assert denial["status"] == "DENIED"

    def test_two_step_confirm_expired(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "Test", "corr_ts4",
        )
        engine.approve_step1(result["approval_id"], "user:test")

        # Manually expire the confirm window
        past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
        conn.execute(
            "UPDATE approvals_queue SET confirm_expires_at = ? WHERE approval_id = ?",
            [past, result["approval_id"]],
        )
        conn.commit()

        final = engine.approve_final(result["approval_id"], "user:test")
        assert final["status"] == "EXPIRED"

    def test_approve_final_without_step1_is_noop(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "Test", "corr_ts5",
        )
        final = engine.approve_final(result["approval_id"], "user:test")
        assert final["status"] == "NOOP"

    def test_get_pending_includes_step1(self):
        engine, conn = self._engine()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "Test", "corr_ts6",
        )
        engine.approve_step1(result["approval_id"], "user:test")
        pending = engine.get_pending()
        assert len(pending) == 1
        assert pending[0]["status"] == "APPROVED_STEP1"


# ══════════════════════════════════════════
# 4. HMAC Callback Signing Tests
# ══════════════════════════════════════════


class TestCallbackSigning:

    def _engine(self, conn=None):
        from packages.agencyu.approvals.engine import ApprovalEngine

        if conn is None:
            conn = _make_conn()
        return ApprovalEngine(conn=conn, policy=TWO_STEP_POLICY, signing_secret="test-secret-key"), conn

    def test_sign_and_verify(self):
        engine, conn = self._engine()
        signed = engine.sign_callback("approve", "appr_test123")
        parts = signed.split(":")
        assert len(parts) == 4
        assert parts[0] == "approve"
        assert parts[1] == "appr_test123"

        valid, action, approval_id = engine.verify_callback(signed)
        assert valid is True
        assert action == "approve"
        assert approval_id == "appr_test123"

    def test_nonce_consumed(self):
        engine, conn = self._engine()
        signed = engine.sign_callback("approve", "appr_test456")
        engine.verify_callback(signed)

        # Replay should fail
        valid, _, _ = engine.verify_callback(signed)
        assert valid is False

    def test_tampered_signature_rejected(self):
        engine, conn = self._engine()
        signed = engine.sign_callback("approve", "appr_test789")
        parts = signed.split(":")
        parts[3] = "0000000000000000"
        tampered = ":".join(parts)

        valid, _, _ = engine.verify_callback(tampered)
        assert valid is False

    def test_wrong_format_rejected(self):
        engine, conn = self._engine()
        valid, _, _ = engine.verify_callback("bad:data")
        assert valid is False

        valid2, _, _ = engine.verify_callback("just_garbage")
        assert valid2 is False


# ══════════════════════════════════════════
# 5. Telegram Bot Tests
# ══════════════════════════════════════════


class TestTelegramBot:

    def test_send_blocked_for_unknown_chat_id(self):
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        result = bot.send(999, "Hello")
        assert result.get("skipped") is True

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_allowed(self, mock_post):
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        result = bot.send(111, "Hello")
        assert result.get("ok") is True

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_approval_request_with_two_step(self, mock_post):
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        result = bot.send_approval_request(
            chat_id=111, approval_id="appr_test",
            action_type="meta.launch_campaign",
            summary="Test", expires_at="2025-12-01T00:00:00",
            requires_two_step=True, risk_level="high", brand="fulldigital",
            confirm_expires_at="2025-12-01T00:10:00",
        )
        assert result.get("ok") is True
        call_json = mock_post.call_args.kwargs["json"]
        assert "2-step approval" in call_json["text"]
        assert "FULL DIGITAL" in call_json["text"]

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_confirm_request(self, mock_post):
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        result = bot.send_confirm_request(
            chat_id=111, approval_id="appr_test",
            confirm_expires_at="2025-12-01T00:10:00",
        )
        assert result.get("ok") is True
        call_json = mock_post.call_args.kwargs["json"]
        assert "Confirm" in call_json["text"]


# ══════════════════════════════════════════
# 6. Telegram Webhook Tests
# ══════════════════════════════════════════


class TestTelegramWebhook:

    def _setup(self, policy=None):
        from packages.agencyu.approvals.engine import ApprovalEngine
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        conn = _make_conn()
        engine = ApprovalEngine(
            conn=conn,
            policy=policy or TWO_STEP_POLICY,
            signing_secret="test-secret",
        )
        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        bot.send = MagicMock(return_value={"ok": True})
        bot.answer_callback = MagicMock(return_value={"ok": True})
        bot.send_confirm_request = MagicMock(return_value={"ok": True})
        return engine, bot, conn

    def _make_app(self, engine, bot, webhook_secret=""):
        from fastapi import FastAPI

        from packages.agencyu.messaging.telegram_webhook import create_telegram_router

        app = FastAPI()
        app.include_router(create_telegram_router(engine, bot, webhook_secret=webhook_secret))
        return app

    @pytest.mark.asyncio
    async def test_health_command(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        client = TestClient(self._make_app(engine, bot))

        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": "/health"},
        })
        assert resp.status_code == 200
        bot.send.assert_called_once()

    @pytest.mark.asyncio
    async def test_approvals_command_shows_two_step(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        engine.request_approval("meta.launch_campaign", "fulldigital", {"risk_level": "high"}, "High-risk test", "c1")

        client = TestClient(self._make_app(engine, bot))
        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": "/approvals"},
        })
        assert resp.status_code == 200
        assert bot.send.call_count >= 1
        msg_text = bot.send.call_args.args[1]
        assert "2-step" in msg_text

    @pytest.mark.asyncio
    async def test_approve_command_single_step(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup(policy={
            "approvals": {
                "enabled": True, "default_mode": "require",
                "actions_require_approval": ["meta.launch_campaign"],
                "safe_actions_auto_allowed": ["meta.pause_adset"],
            }
        })
        result = engine.request_approval("meta.launch_campaign", "fulldigital", {}, "Test", "c1")
        client = TestClient(self._make_app(engine, bot))

        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": f"/approve {result['approval_id']}"},
        })
        assert resp.status_code == 200
        status = engine.get_status(result["approval_id"])
        assert status["status"] == "APPROVED"

    @pytest.mark.asyncio
    async def test_approve_command_two_step_flow(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "High-risk", "c1",
        )
        client = TestClient(self._make_app(engine, bot))

        # Step 1
        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": f"/approve {result['approval_id']}"},
        })
        assert resp.status_code == 200
        status = engine.get_status(result["approval_id"])
        assert status["status"] == "APPROVED_STEP1"
        bot.send_confirm_request.assert_called_once()

        # Step 2
        resp2 = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": f"/approve {result['approval_id']}"},
        })
        assert resp2.status_code == 200
        status2 = engine.get_status(result["approval_id"])
        assert status2["status"] == "APPROVED"

    @pytest.mark.asyncio
    async def test_deny_command(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        result = engine.request_approval("meta.launch_campaign", "fulldigital", {"risk_level": "high"}, "Test", "c1")
        client = TestClient(self._make_app(engine, bot))

        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": f"/deny {result['approval_id']}"},
        })
        assert resp.status_code == 200
        status = engine.get_status(result["approval_id"])
        assert status["status"] == "DENIED"

    @pytest.mark.asyncio
    async def test_unauthorized_blocked(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        client = TestClient(self._make_app(engine, bot))

        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 999}, "text": "/health"},
        })
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_signed_callback_approve_two_step(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "High-risk", "c1",
        )
        client = TestClient(self._make_app(engine, bot))

        # Signed approve callback
        signed_approve = engine.sign_callback("approve", result["approval_id"])
        resp = client.post("/webhooks/telegram", json={
            "callback_query": {
                "id": "cq_1", "message": {"chat": {"id": 111}},
                "data": signed_approve,
            },
        })
        assert resp.status_code == 200
        status = engine.get_status(result["approval_id"])
        assert status["status"] == "APPROVED_STEP1"
        bot.send_confirm_request.assert_called_once()

        # Signed confirm callback
        signed_confirm = engine.sign_callback("confirm", result["approval_id"])
        resp2 = client.post("/webhooks/telegram", json={
            "callback_query": {
                "id": "cq_2", "message": {"chat": {"id": 111}},
                "data": signed_confirm,
            },
        })
        assert resp2.status_code == 200
        status2 = engine.get_status(result["approval_id"])
        assert status2["status"] == "APPROVED"

    @pytest.mark.asyncio
    async def test_signed_callback_deny(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "Test", "c1",
        )
        client = TestClient(self._make_app(engine, bot))

        signed_deny = engine.sign_callback("deny", result["approval_id"])
        resp = client.post("/webhooks/telegram", json={
            "callback_query": {
                "id": "cq_3", "message": {"chat": {"id": 111}},
                "data": signed_deny,
            },
        })
        assert resp.status_code == 200
        status = engine.get_status(result["approval_id"])
        assert status["status"] == "DENIED"

    @pytest.mark.asyncio
    async def test_replayed_callback_rejected(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        result = engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "Test", "c1",
        )
        client = TestClient(self._make_app(engine, bot))

        signed = engine.sign_callback("approve", result["approval_id"])
        # First use
        client.post("/webhooks/telegram", json={
            "callback_query": {"id": "cq_4", "message": {"chat": {"id": 111}}, "data": signed},
        })
        # Replay
        resp2 = client.post("/webhooks/telegram", json={
            "callback_query": {"id": "cq_5", "message": {"chat": {"id": 111}}, "data": signed},
        })
        assert resp2.status_code == 200
        assert bot.answer_callback.call_count >= 2

    @pytest.mark.asyncio
    async def test_webhook_secret_path(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        client = TestClient(self._make_app(engine, bot, webhook_secret="my-secret-path"))

        # Correct path
        resp = client.post("/webhooks/telegram/my-secret-path", json={
            "message": {"chat": {"id": 111}, "text": "/health"},
        })
        assert resp.status_code == 200

        # Wrong path returns 404
        resp2 = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": "/health"},
        })
        assert resp2.status_code in (404, 405)

    @pytest.mark.asyncio
    async def test_unknown_command_shows_help(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        client = TestClient(self._make_app(engine, bot))

        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": "/foobar"},
        })
        assert resp.status_code == 200
        msg_text = bot.send.call_args.args[1]
        assert "/health" in msg_text
        assert "/approvals" in msg_text

    @pytest.mark.asyncio
    async def test_webops_status_command(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        client = TestClient(self._make_app(engine, bot))

        resp = client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": "/webops status"},
        })
        assert resp.status_code == 200
        bot.send.assert_called_once()

    @pytest.mark.asyncio
    async def test_unsigned_callback_legacy_compat(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup(policy={
            "approvals": {
                "enabled": True, "default_mode": "require",
                "actions_require_approval": ["meta.launch_campaign"],
                "safe_actions_auto_allowed": [],
            }
        })
        result = engine.request_approval("meta.launch_campaign", "fulldigital", {}, "Test", "c1")
        client = TestClient(self._make_app(engine, bot))

        resp = client.post("/webhooks/telegram", json={
            "callback_query": {
                "id": "cq_legacy", "message": {"chat": {"id": 111}},
                "data": f"approve:{result['approval_id']}",
            },
        })
        assert resp.status_code == 200
        status = engine.get_status(result["approval_id"])
        assert status["status"] == "APPROVED"
