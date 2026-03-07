"""Tests for approval card rendering, ApprovalRequest dataclass, CC widget, and Notion mirror."""
from __future__ import annotations

import sqlite3
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
    conn.execute("""
        CREATE TABLE meta_active_budgets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            brand TEXT NOT NULL,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            object_name TEXT NOT NULL,
            daily_budget_usd REAL NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE UNIQUE INDEX idx_meta_active_budgets_unique
        ON meta_active_budgets(object_type, object_id)
    """)
    conn.execute("""
        CREATE TABLE scheduled_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            run_at_iso TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_ts TEXT,
            updated_ts TEXT
        )
    """)
    conn.commit()
    return conn


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
            ],
        },
        "actions_require_approval": [
            "meta.launch_campaign",
            "meta.increase_budget",
        ],
        "safe_actions_auto_allowed": [
            "meta.pause_adset",
        ],
    }
}


# ══════════════════════════════════════════
# 1. Approval Card Renderer Tests
# ══════════════════════════════════════════


class TestApprovalCard:

    def test_brand_chip_fulldigital(self):
        from packages.agencyu.messaging.approval_card import brand_chip

        assert "FULL DIGITAL" in brand_chip("fulldigital")

    def test_brand_chip_cutmv(self):
        from packages.agencyu.messaging.approval_card import brand_chip

        assert "CUTMV" in brand_chip("cutmv")

    def test_brand_chip_unknown(self):
        from packages.agencyu.messaging.approval_card import brand_chip

        result = brand_chip("somebrand")
        assert "SOMEBRAND" in result

    def test_risk_chip_low(self):
        from packages.agencyu.messaging.approval_card import risk_chip

        assert "LOW" in risk_chip("low")

    def test_risk_chip_medium(self):
        from packages.agencyu.messaging.approval_card import risk_chip

        assert "MEDIUM" in risk_chip("medium")

    def test_risk_chip_high(self):
        from packages.agencyu.messaging.approval_card import risk_chip

        assert "HIGH" in risk_chip("high")

    def test_fmt_usd(self):
        from packages.agencyu.messaging.approval_card import fmt_usd

        assert fmt_usd(1234.5) == "$1,234"
        assert fmt_usd(0) == "$0"

    def test_fmt_pct(self):
        from packages.agencyu.messaging.approval_card import fmt_pct

        assert fmt_pct(0.75) == "75%"
        assert fmt_pct(1.0) == "100%"
        assert fmt_pct(0.0) == "0%"

    def test_approval_card_text_meta_action(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        text = approval_card_text(
            approval_id="appr_test123",
            action_type="meta.increase_budget",
            brand="fulldigital",
            estimated_spend_impact_usd=25.0,
            risk_level="medium",
            why_now="Budget optimization needed",
            rollback_plan="Rollback: reduce budget to previous level",
            expires_at="2026-03-06T12:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_abc",
        )
        assert "FULL DIGITAL" in text
        assert "meta.increase_budget" in text
        assert "+$25/day" in text
        assert "MEDIUM" in text
        assert "Budget optimization needed" in text
        assert "Rollback: reduce budget to previous level" in text
        assert "appr_test123" in text
        assert "corr_abc" in text

    def test_approval_card_auto_reads_meta_cap_from_config(self):
        """Meta actions auto-read the daily cap from experiment_policy.yaml."""
        from packages.agencyu.messaging.approval_card import approval_card_text

        text = approval_card_text(
            approval_id="appr_auto_cap",
            action_type="meta.increase_budget",
            brand="fulldigital",
            estimated_spend_impact_usd=50.0,
            risk_level="medium",
            why_now="ROAS strong",
            rollback_plan="Revert budget",
            expires_at="2026-03-07T12:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_auto",
            # NOTE: max_daily_spend_hard_cap_usd is NOT passed
        )
        # Should still show the cap line from experiment_policy.yaml
        assert "$200/day (hard stop)" in text

    def test_approval_card_non_meta_no_cap_line(self):
        """Non-meta actions never show the daily cap line."""
        from packages.agencyu.messaging.approval_card import approval_card_text

        text = approval_card_text(
            approval_id="appr_stripe",
            action_type="stripe.refund",
            brand="cutmv",
            estimated_spend_impact_usd=-30.0,
            risk_level="low",
            why_now="Refund needed",
            rollback_plan="Void refund",
            expires_at="2026-03-07T12:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_stripe",
        )
        assert "hard stop" not in text

    def test_approval_card_text_non_meta_action(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        text = approval_card_text(
            approval_id="appr_xyz",
            action_type="stripe.refund",
            brand="cutmv",
            estimated_spend_impact_usd=-50.0,
            risk_level="high",
            why_now="Customer refund request",
            rollback_plan="Rollback: void the refund",
            expires_at="2026-03-06T12:00:00",
            requires_two_step=True,
            confirm_expires_at="2026-03-06T12:10:00",
            correlation_id="corr_def",
        )
        assert "CUTMV" in text
        assert "-$50" in text
        assert "/day" not in text  # non-meta shouldn't have /day
        assert "2-step approval" in text
        assert "Confirm window" in text

    def test_approval_card_text_with_hard_cap(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        text = approval_card_text(
            approval_id="appr_cap",
            action_type="meta.launch_campaign",
            brand="fulldigital",
            estimated_spend_impact_usd=100.0,
            risk_level="high",
            why_now="New campaign launch",
            rollback_plan="Rollback: pause campaign",
            expires_at="2026-03-06T12:00:00",
            requires_two_step=True,
            confirm_expires_at="2026-03-06T12:10:00",
            correlation_id="corr_cap",
            max_daily_spend_hard_cap_usd=200,
        )
        assert "$200/day (hard stop)" in text


# ══════════════════════════════════════════
# 1b. Dynamic Meta Cap Card (with snapshot)
# ══════════════════════════════════════════


class TestApprovalCardDynamic:

    def _make_snapshot(self, total=160.0, cap=200.0, soft=0.75):
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetSnapshot

        ratio = total / cap if cap > 0 else 0.0
        return MetaBudgetSnapshot(
            total_daily_budget_usd=total,
            cap_usd=cap,
            cap_used_ratio=ratio,
            soft_warning_ratio=soft,
            soft_warning_active=(ratio >= soft),
            computed_at="2026-03-07T12:00:00+00:00",
            source="budgets",
        )

    def test_card_shows_dynamic_budget_line(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=160.0, cap=200.0)
        text = approval_card_text(
            approval_id="appr_dyn1",
            action_type="meta.increase_budget",
            brand="fulldigital",
            estimated_spend_impact_usd=50.0,
            risk_level="high",
            why_now="Winner stabilized",
            rollback_plan="Revert budget",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=True,
            confirm_expires_at="2026-03-07T22:10:00",
            correlation_id="corr_dyn1",
            meta_budget_snapshot=snap,
        )
        assert "$200/day (hard stop)" in text
        assert "Today budget: $160/day of $200/day (80% of cap)" in text
        assert "Soft warning" in text  # 80% >= 75% threshold

    def test_card_no_soft_warning_below_threshold(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=100.0, cap=200.0)
        text = approval_card_text(
            approval_id="appr_dyn2",
            action_type="meta.increase_budget",
            brand="fulldigital",
            estimated_spend_impact_usd=20.0,
            risk_level="medium",
            why_now="Gradual scale",
            rollback_plan="Reduce budget",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_dyn2",
            meta_budget_snapshot=snap,
        )
        assert "Today budget: $100/day of $200/day (50% of cap)" in text
        assert "Soft warning" not in text

    def test_card_snapshot_overrides_static_cap(self):
        """When snapshot is given, max_daily_spend_hard_cap_usd is ignored."""
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=50.0, cap=300.0)
        text = approval_card_text(
            approval_id="appr_dyn3",
            action_type="meta.launch_campaign",
            brand="cutmv",
            estimated_spend_impact_usd=30.0,
            risk_level="low",
            why_now="Test launch",
            rollback_plan="Pause campaign",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_dyn3",
            max_daily_spend_hard_cap_usd=200,  # should be ignored
            meta_budget_snapshot=snap,
        )
        assert "$300/day (hard stop)" in text
        assert "$200/day" not in text.replace("$300/day", "")

    def test_non_meta_action_ignores_snapshot(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=160.0, cap=200.0)
        text = approval_card_text(
            approval_id="appr_dyn4",
            action_type="stripe.refund",
            brand="cutmv",
            estimated_spend_impact_usd=-50.0,
            risk_level="medium",
            why_now="Refund",
            rollback_plan="Void",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_dyn4",
            meta_budget_snapshot=snap,
        )
        assert "hard stop" not in text
        assert "Today budget" not in text


# ══════════════════════════════════════════
# 2. ApprovalRequest Dataclass Tests
# ══════════════════════════════════════════


class TestApprovalRequest:

    def test_basic_creation(self):
        from packages.agencyu.approvals.types import ApprovalRequest

        req = ApprovalRequest(
            action_type="meta.launch_campaign",
            brand="fulldigital",
            risk_level="high",
            estimated_spend_impact_usd=100.0,
            why_now="New campaign",
            rollback_plan="Pause campaign",
            payload={"campaign_id": "123"},
            correlation_id="corr_1",
        )
        assert req.action_type == "meta.launch_campaign"
        assert req.brand == "fulldigital"

    def test_ensure_defaults_fills_empty_why_now(self):
        from packages.agencyu.approvals.types import ApprovalRequest

        req = ApprovalRequest(
            action_type="meta.launch_campaign",
            brand="fulldigital",
            risk_level="high",
            estimated_spend_impact_usd=100.0,
            why_now="",
            rollback_plan="",
            payload={},
            correlation_id="corr_2",
        )
        warnings = req.ensure_defaults()
        assert len(warnings) == 2
        assert req.why_now != ""
        assert req.rollback_plan != ""

    def test_ensure_defaults_no_warnings_when_filled(self):
        from packages.agencyu.approvals.types import ApprovalRequest

        req = ApprovalRequest(
            action_type="meta.launch_campaign",
            brand="fulldigital",
            risk_level="high",
            estimated_spend_impact_usd=50.0,
            why_now="Needed for campaign",
            rollback_plan="Pause and reduce",
            payload={},
            correlation_id="corr_3",
        )
        warnings = req.ensure_defaults()
        assert len(warnings) == 0

    def test_to_engine_kwargs(self):
        from packages.agencyu.approvals.types import ApprovalRequest

        req = ApprovalRequest(
            action_type="meta.increase_budget",
            brand="fulldigital",
            risk_level="medium",
            estimated_spend_impact_usd=25.0,
            why_now="Performance looks good",
            rollback_plan="Reduce budget",
            payload={"old_budget": 100, "new_budget": 125},
            correlation_id="corr_4",
            compound_action_key="meta.launch_campaign+meta.increase_budget",
        )
        kwargs = req.to_engine_kwargs()
        assert kwargs["action_type"] == "meta.increase_budget"
        assert kwargs["brand"] == "fulldigital"
        assert kwargs["risk_level"] == "medium"
        assert kwargs["payload"]["estimated_spend_impact_usd"] == 25.0
        assert kwargs["payload"]["compound_action_key"] == "meta.launch_campaign+meta.increase_budget"


# ══════════════════════════════════════════
# 3. Updated Telegram Bot Card Tests
# ══════════════════════════════════════════


class TestTelegramBotApprovalCard:

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_approval_request_renders_card(self, mock_post):
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        result = bot.send_approval_request(
            chat_id=111,
            approval_id="appr_card1",
            action_type="meta.launch_campaign",
            summary="Test campaign",
            expires_at="2026-03-06T12:00:00",
            requires_two_step=True,
            risk_level="high",
            brand="fulldigital",
            estimated_spend_impact_usd=150.0,
            why_now="New Q2 campaign",
            rollback_plan="Pause campaign and recheck",
            correlation_id="corr_card1",
            confirm_expires_at="2026-03-06T12:10:00",
            max_daily_spend_hard_cap_usd=200,
        )
        assert result.get("ok") is True
        call_json = mock_post.call_args.kwargs["json"]
        text = call_json["text"]
        # Card content checks
        assert "FULL DIGITAL" in text
        assert "meta.launch_campaign" in text
        assert "+$150/day" in text
        assert "HIGH" in text
        assert "New Q2 campaign" in text
        assert "$200/day (hard stop)" in text
        assert "2-step approval" in text
        # Button checks
        buttons = call_json["reply_markup"]["inline_keyboard"]
        assert len(buttons) == 1
        assert len(buttons[0]) == 2
        assert "Approve" in buttons[0][0]["text"]
        assert "Deny" in buttons[0][1]["text"]

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_approval_request_with_snapshot(self, mock_post):
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetSnapshot
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        snap = MetaBudgetSnapshot(
            total_daily_budget_usd=160.0,
            cap_usd=200.0,
            cap_used_ratio=0.80,
            soft_warning_ratio=0.75,
            soft_warning_active=True,
            computed_at="2026-03-07T12:00:00+00:00",
            source="budgets",
        )

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        bot.send_approval_request(
            chat_id=111,
            approval_id="appr_snap1",
            action_type="meta.increase_budget",
            summary="Scale winner",
            expires_at="2026-03-07T22:00:00",
            risk_level="high",
            brand="fulldigital",
            estimated_spend_impact_usd=50.0,
            why_now="Combo 14 stabilized at 2.4x ROAS",
            rollback_plan="Revert budget",
            correlation_id="corr_snap1",
            meta_budget_snapshot=snap,
        )
        call_json = mock_post.call_args.kwargs["json"]
        text = call_json["text"]
        assert "Today budget: $160/day of $200/day (80% of cap)" in text
        assert "Soft warning" in text

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_approval_request_uses_summary_when_no_why_now(self, mock_post):
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        bot.send_approval_request(
            chat_id=111,
            approval_id="appr_card2",
            action_type="webflow.publish",
            summary="Publish landing page",
            expires_at="2026-03-06T12:00:00",
            brand="cutmv",
        )
        call_json = mock_post.call_args.kwargs["json"]
        text = call_json["text"]
        assert "Publish landing page" in text  # summary used as why_now fallback


# ══════════════════════════════════════════
# 4. Updated Webhook /approvals Listing Tests
# ══════════════════════════════════════════


class TestWebhookApprovalListing:

    def _setup(self):
        from packages.agencyu.approvals.engine import ApprovalEngine
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        conn = _make_conn()
        engine = ApprovalEngine(
            conn=conn, policy=TWO_STEP_POLICY, signing_secret="test-secret",
        )
        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        bot.send = MagicMock(return_value={"ok": True})
        bot.answer_callback = MagicMock(return_value={"ok": True})
        bot.send_confirm_request = MagicMock(return_value={"ok": True})
        return engine, bot, conn

    def _make_app(self, engine, bot):
        from fastapi import FastAPI

        from packages.agencyu.messaging.telegram_webhook import create_telegram_router

        app = FastAPI()
        app.include_router(create_telegram_router(engine, bot))
        return app

    @pytest.mark.asyncio
    async def test_approvals_listing_shows_brand_and_risk_chips(self):
        from fastapi.testclient import TestClient

        engine, bot, conn = self._setup()
        engine.request_approval(
            "meta.launch_campaign", "fulldigital",
            {"risk_level": "high"}, "High-risk test", "c1",
        )

        client = TestClient(self._make_app(engine, bot))
        client.post("/webhooks/telegram", json={
            "message": {"chat": {"id": 111}, "text": "/approvals"},
        })

        msg_text = bot.send.call_args.args[1]
        assert "FULL DIGITAL" in msg_text
        assert "HIGH" in msg_text
        assert "2-step" in msg_text


# ══════════════════════════════════════════
# 5. CC Approvals Widget Tests
# ══════════════════════════════════════════


class TestCCApprovalsWidget:

    def test_render_no_pending(self):
        from packages.agencyu.notion.widgets.cc_approvals import render_cc_approvals

        blocks = render_cc_approvals({"pending_approvals": []})
        assert len(blocks) >= 3
        # Should have "All clear" callout
        callout_blocks = [b for b in blocks if b.get("type") == "callout"]
        assert any("All clear" in str(b) for b in callout_blocks)

    def test_render_with_pending(self):
        from packages.agencyu.notion.widgets.cc_approvals import render_cc_approvals

        pending = [
            {
                "approval_id": "appr_test1",
                "action_type": "meta.launch_campaign",
                "brand": "fulldigital",
                "risk_level": "high",
                "status": "PENDING",
                "requires_two_step": True,
                "expires_at": "2026-03-06T12:00:00",
            },
            {
                "approval_id": "appr_test2",
                "action_type": "stripe.refund",
                "brand": "cutmv",
                "risk_level": "medium",
                "status": "APPROVED_STEP1",
                "requires_two_step": True,
                "expires_at": "2026-03-06T12:00:00",
            },
        ]
        blocks = render_cc_approvals({
            "pending_approvals": pending,
            "telegram_bot_username": "openclaw_bot",
        })
        # Should mention count
        callout_blocks = [b for b in blocks if b.get("type") == "callout"]
        assert any("2" in str(b) for b in callout_blocks)

        # Should have list items
        list_blocks = [b for b in blocks if b.get("type") == "bulleted_list_item"]
        assert len(list_blocks) == 2

        # Should have Telegram link
        text_blocks = [b for b in blocks if b.get("type") == "paragraph"]
        assert any("t.me/openclaw_bot" in str(b) for b in text_blocks)

    def test_render_more_than_5_shows_ellipsis(self):
        from packages.agencyu.notion.widgets.cc_approvals import render_cc_approvals

        pending = [
            {
                "approval_id": f"appr_{i}",
                "action_type": "meta.launch_campaign",
                "brand": "fulldigital",
                "risk_level": "high",
                "status": "PENDING",
                "requires_two_step": False,
                "expires_at": "2026-03-06T12:00:00",
            }
            for i in range(8)
        ]
        blocks = render_cc_approvals({"pending_approvals": pending})
        list_blocks = [b for b in blocks if b.get("type") == "bulleted_list_item"]
        assert len(list_blocks) == 5  # Only top 5 shown

        text_blocks = [b for b in blocks if b.get("type") == "paragraph"]
        assert any("3 more" in str(b) for b in text_blocks)


# ══════════════════════════════════════════
# 6. Notion Approvals Mirror Writer Tests
# ══════════════════════════════════════════


class TestApprovalsWriter:

    def test_mirror_safe_mode(self):
        from packages.agencyu.notion.mirrors.approvals_writer import mirror_approval_to_notion

        api = MagicMock()
        approval = {
            "approval_id": "appr_mirror1",
            "brand": "fulldigital",
            "action_type": "meta.launch_campaign",
            "risk_level": "high",
            "status": "PENDING",
            "summary": "Test",
            "correlation_id": "corr_1",
            "expires_at": "2026-03-06T12:00:00",
            "payload_json": '{"estimated_spend_impact_usd": 100}',
        }
        result = mirror_approval_to_notion(
            api, db_id="fake_db", approval=approval, safe_mode=True,
        )
        assert result["simulated"] is True
        api.query_database.assert_not_called()

    def test_mirror_creates_new_page(self):
        from packages.agencyu.notion.mirrors.approvals_writer import mirror_approval_to_notion

        api = MagicMock()
        api.query_database.return_value = {"results": []}
        api._request.return_value = {"id": "page_123"}

        approval = {
            "approval_id": "appr_mirror2",
            "brand": "cutmv",
            "action_type": "stripe.refund",
            "risk_level": "medium",
            "status": "PENDING",
            "summary": "Refund test",
            "correlation_id": "corr_2",
            "expires_at": "2026-03-06T12:00:00",
            "payload_json": '{"estimated_spend_impact_usd": -50}',
        }
        result = mirror_approval_to_notion(
            api, db_id="fake_db", approval=approval, safe_mode=False,
            telegram_bot_username="openclaw_bot",
        )
        assert result["action"] == "created"
        assert result["page_id"] == "page_123"

    def test_mirror_updates_existing_page(self):
        from packages.agencyu.notion.mirrors.approvals_writer import mirror_approval_to_notion

        api = MagicMock()
        api.query_database.return_value = {"results": [{"id": "existing_page"}]}

        approval = {
            "approval_id": "appr_mirror3",
            "brand": "fulldigital",
            "action_type": "meta.increase_budget",
            "risk_level": "high",
            "status": "APPROVED",
            "summary": "Budget increase",
            "correlation_id": "corr_3",
            "expires_at": "2026-03-06T12:00:00",
            "payload_json": "{}",
        }
        result = mirror_approval_to_notion(
            api, db_id="fake_db", approval=approval, safe_mode=False,
        )
        assert result["action"] == "updated"
        api.update_page.assert_called_once()

    def test_mirror_all_pending(self):
        from packages.agencyu.notion.mirrors.approvals_writer import mirror_pending_approvals

        api = MagicMock()
        approvals = [
            {
                "approval_id": f"appr_batch_{i}",
                "brand": "fulldigital",
                "action_type": "meta.launch_campaign",
                "risk_level": "high",
                "status": "PENDING",
                "summary": "Test",
                "correlation_id": f"corr_{i}",
                "expires_at": "2026-03-06T12:00:00",
                "payload_json": "{}",
            }
            for i in range(3)
        ]
        result = mirror_pending_approvals(
            api, db_id="fake_db", approvals=approvals, safe_mode=True,
        )
        assert result["total"] == 3
        assert all(r["simulated"] for r in result["results"])


# ══════════════════════════════════════════
# 7. Meta Daily Cap Enforcement Tests
# ══════════════════════════════════════════


class TestEnforceMetaCap:

    def test_enforce_meta_cap_within_limit(self):
        from packages.agencyu.engines.meta_ads import enforce_meta_cap

        # Should not raise when budget is within cap
        enforce_meta_cap(150.0, cap=200.0)

    def test_enforce_meta_cap_at_limit(self):
        from packages.agencyu.engines.meta_ads import enforce_meta_cap

        # Exactly at cap — allowed
        enforce_meta_cap(200.0, cap=200.0)

    def test_enforce_meta_cap_exceeds_limit(self):
        from packages.agencyu.engines.meta_ads import enforce_meta_cap

        with pytest.raises(ValueError, match="exceeds configured max_daily_budget_cap_usd"):
            enforce_meta_cap(250.0, cap=200.0)

    def test_enforce_meta_cap_reads_from_config(self):
        from packages.agencyu.engines.meta_ads import enforce_meta_cap

        # Without explicit cap, reads from experiment_policy.yaml (200)
        enforce_meta_cap(199.0)  # should not raise

        with pytest.raises(ValueError):
            enforce_meta_cap(999.0)  # way over the configured 200

    def test_get_meta_daily_cap_returns_value(self):
        from packages.agencyu.messaging.approval_card import get_meta_daily_cap

        cap = get_meta_daily_cap()
        assert cap == 200


# ══════════════════════════════════════════
# 8. MetaBudgetTracker Tests
# ══════════════════════════════════════════


class TestMetaBudgetTracker:

    def _make_tracker(self, conn=None, policy=None):
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetTracker

        conn = conn or _make_conn()
        policy = policy or {"meta": {"max_daily_budget_cap_usd": 200, "soft_warning_ratio": 0.75}}
        return MetaBudgetTracker(conn=conn, policy=policy), conn

    def test_snapshot_empty_db(self):
        tracker, _ = self._make_tracker()
        snap = tracker.snapshot()
        assert snap.total_daily_budget_usd == 0.0
        assert snap.cap_usd == 200.0
        assert snap.cap_used_ratio == 0.0
        assert snap.soft_warning_active is False
        assert snap.source == "budgets"

    def test_upsert_and_snapshot(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 50.0)
        tracker.upsert_budget("fulldigital", "adset", "adset_2", "camp/adset_2", 80.0)
        tracker.upsert_budget("cutmv", "adset", "adset_3", "camp/adset_3", 30.0)

        # Global snapshot
        snap = tracker.snapshot()
        assert snap.total_daily_budget_usd == 160.0
        assert snap.cap_used_ratio == pytest.approx(0.80)
        assert snap.soft_warning_active is True  # 80% >= 75%

        # Brand-filtered
        snap_fd = tracker.snapshot(brand="fulldigital")
        assert snap_fd.total_daily_budget_usd == 130.0

    def test_upsert_updates_existing(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 50.0)
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 75.0)

        snap = tracker.snapshot()
        assert snap.total_daily_budget_usd == 75.0  # updated, not added

    def test_deactivate_budget(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 100.0)
        tracker.deactivate_budget("adset", "adset_1")

        snap = tracker.snapshot()
        assert snap.total_daily_budget_usd == 0.0

    def test_check_projected_total(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 120.0)

        projected = tracker.check_projected_total(delta_usd=50.0)
        assert projected.total_daily_budget_usd == 170.0
        assert projected.cap_used_ratio == pytest.approx(0.85)
        assert projected.soft_warning_active is True

    def test_enforce_cap_allows(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 100.0)
        tracker.enforce_cap(delta_usd=50.0)  # 150 < 200 → ok

    def test_enforce_cap_blocks(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 180.0)
        with pytest.raises(ValueError, match="exceeds cap"):
            tracker.enforce_cap(delta_usd=50.0)  # 230 > 200

    def test_escalate_risk_level(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 160.0)

        # 160 + 10 = 170 → 85% → soft warning → escalate
        assert tracker.escalate_risk_level("low", delta_usd=10.0) == "medium"
        assert tracker.escalate_risk_level("medium", delta_usd=10.0) == "high"
        assert tracker.escalate_risk_level("high", delta_usd=10.0) == "high"

    def test_no_escalation_below_threshold(self):
        tracker, conn = self._make_tracker()
        tracker.upsert_budget("fulldigital", "adset", "adset_1", "camp/adset_1", 50.0)

        # 50 + 10 = 60 → 30% → no warning
        assert tracker.escalate_risk_level("low", delta_usd=10.0) == "low"

    def test_config_reads_from_yaml_when_no_policy(self):
        """When no policy dict is passed, reads from experiment_policy.yaml."""
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetTracker

        conn = _make_conn()
        tracker = MetaBudgetTracker(conn=conn)  # no policy → reads YAML
        assert tracker.get_daily_budget_cap() == 200.0
        assert tracker.get_soft_warning_ratio() == 0.75


# ══════════════════════════════════════════
# 9. MetaAdsManager + Budget Tracker Integration
# ══════════════════════════════════════════


class TestMetaAdsManagerBudgetTracking:

    def test_create_ad_set_upserts_budget(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetTracker

        conn = _make_conn()
        policy = {"meta": {"max_daily_budget_cap_usd": 200, "soft_warning_ratio": 0.75}}
        tracker = MetaBudgetTracker(conn=conn, policy=policy)
        mgr = MetaAdsManager(budget_tracker=tracker)

        mgr.create_ad_set(
            campaign_id="camp_test",
            brand="fulldigital",
            audience_id="aud_1",
            daily_budget=50.0,
        )

        snap = tracker.snapshot()
        assert snap.total_daily_budget_usd == 50.0

    def test_create_ad_set_blocked_by_cap(self):
        from packages.agencyu.engines.meta_ads import MetaAdsManager

        mgr = MetaAdsManager()
        with pytest.raises(ValueError, match="exceeds configured max_daily_budget_cap_usd"):
            mgr.create_ad_set(
                campaign_id="camp_test",
                brand="fulldigital",
                audience_id="aud_1",
                daily_budget=999.0,
            )


# ══════════════════════════════════════════
# 10. Projected Status + check_projected_blocked Tests
# ══════════════════════════════════════════


class TestProjectedStatus:

    def _make_snapshot(self, total=100.0, cap=200.0, soft=0.75):
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetSnapshot

        ratio = total / cap if cap > 0 else 0.0
        return MetaBudgetSnapshot(
            total_daily_budget_usd=total,
            cap_usd=cap,
            cap_used_ratio=ratio,
            soft_warning_ratio=soft,
            soft_warning_active=(ratio >= soft),
            computed_at="2026-03-07T12:00:00+00:00",
            source="budgets",
        )

    def test_projected_status_ok(self):
        from packages.agencyu.messaging.approval_card import projected_status

        assert projected_status(0.50, 0.75) == "\u2192 OK"

    def test_projected_status_warning(self):
        from packages.agencyu.messaging.approval_card import projected_status

        assert projected_status(0.80, 0.75) == "\u2192 \u26a0\ufe0f WARNING"
        # Exactly at threshold
        assert projected_status(0.75, 0.75) == "\u2192 \u26a0\ufe0f WARNING"

    def test_projected_status_blocked(self):
        from packages.agencyu.messaging.approval_card import projected_status

        assert projected_status(1.05, 0.75) == "\u2192 BLOCKED"

    def test_clamp_ratio_no_negative(self):
        from packages.agencyu.messaging.approval_card import clamp_ratio

        assert clamp_ratio(-0.5) == 0.0
        assert clamp_ratio(0.0) == 0.0
        assert clamp_ratio(1.5) == 1.5

    def test_card_projected_ok(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=100.0, cap=200.0)
        text = approval_card_text(
            approval_id="appr_proj_ok",
            action_type="meta.increase_budget",
            brand="fulldigital",
            estimated_spend_impact_usd=20.0,
            risk_level="low",
            why_now="Gradual scale",
            rollback_plan="Reduce budget",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_proj_ok",
            meta_budget_snapshot=snap,
        )
        assert "Projected after this change: $120/day of $200/day (60% of cap)" in text
        assert "\u2192 OK" in text

    def test_card_projected_warning(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=130.0, cap=200.0)
        text = approval_card_text(
            approval_id="appr_proj_warn",
            action_type="meta.increase_budget",
            brand="fulldigital",
            estimated_spend_impact_usd=30.0,
            risk_level="medium",
            why_now="Strong ROAS",
            rollback_plan="Reduce budget",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_proj_warn",
            meta_budget_snapshot=snap,
        )
        assert "Projected after this change: $160/day of $200/day (80% of cap)" in text
        assert "\u2192 \u26a0\ufe0f WARNING" in text

    def test_card_projected_blocked(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=180.0, cap=200.0)
        text = approval_card_text(
            approval_id="appr_proj_block",
            action_type="meta.increase_budget",
            brand="fulldigital",
            estimated_spend_impact_usd=30.0,
            risk_level="high",
            why_now="Scale attempt",
            rollback_plan="Reduce budget",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=True,
            confirm_expires_at="2026-03-07T22:10:00",
            correlation_id="corr_proj_block",
            meta_budget_snapshot=snap,
        )
        assert "Projected after this change: $210/day of $200/day (105% of cap)" in text
        assert "\u2192 BLOCKED" in text

    def test_check_projected_blocked_true(self):
        from packages.agencyu.messaging.approval_card import check_projected_blocked

        snap = self._make_snapshot(total=180.0, cap=200.0)
        result = check_projected_blocked(snap, delta_usd=30.0)
        assert result["blocked"] is True
        assert result["status"] == "\u2192 BLOCKED"
        assert result["projected_total"] == 210.0
        assert result["ratio_projected"] == pytest.approx(1.05)

    def test_check_projected_blocked_false(self):
        from packages.agencyu.messaging.approval_card import check_projected_blocked

        snap = self._make_snapshot(total=100.0, cap=200.0)
        result = check_projected_blocked(snap, delta_usd=20.0)
        assert result["blocked"] is False
        assert result["projected_total"] == 120.0

    def test_check_projected_no_snapshot(self):
        from packages.agencyu.messaging.approval_card import check_projected_blocked

        result = check_projected_blocked(None, delta_usd=50.0)
        assert result["blocked"] is False
        assert result["status"] == "no_snapshot"

    def test_card_no_projected_line_when_zero_delta(self):
        from packages.agencyu.messaging.approval_card import approval_card_text

        snap = self._make_snapshot(total=100.0, cap=200.0)
        text = approval_card_text(
            approval_id="appr_zero",
            action_type="meta.pause_adset",
            brand="fulldigital",
            estimated_spend_impact_usd=0.0,
            risk_level="low",
            why_now="Pausing",
            rollback_plan="Resume",
            expires_at="2026-03-07T22:00:00",
            requires_two_step=False,
            confirm_expires_at=None,
            correlation_id="corr_zero",
            meta_budget_snapshot=snap,
        )
        assert "Projected after this change" not in text


# ══════════════════════════════════════════
# 11. Budget Reallocation Planner Tests
# ══════════════════════════════════════════


class TestBudgetReallocationPlanner:

    def _seed_budgets(self, conn):
        """Seed meta_active_budgets with test data."""
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetTracker

        tracker = MetaBudgetTracker(
            conn=conn,
            policy={"meta": {"max_daily_budget_cap_usd": 200, "soft_warning_ratio": 0.75}},
        )
        tracker.upsert_budget("fulldigital", "adset", "adset_a", "camp/adset_a", 80.0)
        tracker.upsert_budget("fulldigital", "adset", "adset_b", "camp/adset_b", 60.0)
        tracker.upsert_budget("cutmv", "adset", "adset_c", "camp/adset_c", 40.0)
        return tracker

    def test_suggest_plan_basic(self):
        from packages.agencyu.marketing.budget_reallocation import (
            BudgetReallocationPlanner,
        )

        conn = _make_conn()
        self._seed_budgets(conn)
        planner = BudgetReallocationPlanner(conn=conn)

        plan = planner.suggest_plan(
            brand="fulldigital",
            cap_usd=200.0,
            current_total_usd=180.0,
            delta_usd=30.0,
        )
        assert plan.required_free_usd == 10.0
        assert plan.projected_total_usd == 210.0
        assert len(plan.candidates) >= 1
        freed = sum(c.daily_budget_usd for c in plan.candidates)
        assert freed >= 10.0

    def test_suggest_plan_picks_minimal_set(self):
        from packages.agencyu.marketing.budget_reallocation import (
            BudgetReallocationPlanner,
        )

        conn = _make_conn()
        self._seed_budgets(conn)
        planner = BudgetReallocationPlanner(conn=conn)

        # Need to free $5 — smallest single candidate frees $40 (adset_c)
        plan = planner.suggest_plan(
            brand="fulldigital",
            cap_usd=200.0,
            current_total_usd=195.0,
            delta_usd=10.0,
        )
        assert plan.required_free_usd == 5.0
        assert len(plan.candidates) == 1  # one candidate is enough

    def test_suggest_plan_empty_db(self):
        from packages.agencyu.marketing.budget_reallocation import (
            BudgetReallocationPlanner,
        )

        conn = _make_conn()
        planner = BudgetReallocationPlanner(conn=conn)

        plan = planner.suggest_plan(
            brand="fulldigital",
            cap_usd=200.0,
            current_total_usd=180.0,
            delta_usd=30.0,
        )
        assert plan.required_free_usd == 10.0
        assert len(plan.candidates) == 0

    def test_suggest_plan_with_perf_data(self):
        from packages.agencyu.marketing.budget_reallocation import (
            BudgetReallocationPlanner,
        )

        conn = _make_conn()
        self._seed_budgets(conn)

        # Mock combo store that flags adset_b as killed
        combo_store = MagicMock()
        combo_store.get_perf_by_meta_object.side_effect = lambda oid: (
            {"kill_reason": "cpa_exceeded", "spend_usd": 60}
            if oid == "adset_b"
            else None
        )

        planner = BudgetReallocationPlanner(conn=conn, combo_store=combo_store)
        plan = planner.suggest_plan(
            brand="fulldigital",
            cap_usd=200.0,
            current_total_usd=180.0,
            delta_usd=30.0,
        )
        # adset_b should be first (HIGH confidence from kill rule)
        assert plan.candidates[0].object_id == "adset_b"
        assert plan.candidates[0].confidence == "HIGH"

    def test_overall_confidence(self):
        from packages.agencyu.marketing.budget_reallocation import (
            BudgetReallocationPlanner,
            PauseCandidate,
        )

        conn = _make_conn()
        planner = BudgetReallocationPlanner(conn=conn)

        high = PauseCandidate("adset", "1", "x", 50, "kill", "HIGH")
        med = PauseCandidate("adset", "2", "y", 30, "low roas", "MED")
        low = PauseCandidate("adset", "3", "z", 20, "fallback", "LOW")

        assert planner._overall_confidence([high]) == "HIGH"
        assert planner._overall_confidence([high, low]) == "MED"
        assert planner._overall_confidence([med]) == "MED"
        assert planner._overall_confidence([low]) == "LOW"
        assert planner._overall_confidence([]) == "LOW"


# ══════════════════════════════════════════
# 12. Reallocation Plan Text Formatter Tests
# ══════════════════════════════════════════


class TestReallocationPlanText:

    def test_plan_text_with_candidates(self):
        from packages.agencyu.marketing.budget_reallocation import (
            PauseCandidate,
            ReallocationPlan,
        )
        from packages.agencyu.messaging.approval_card import reallocation_plan_text

        plan = ReallocationPlan(
            blocked_delta_usd=30.0,
            cap_usd=200.0,
            current_total_usd=180.0,
            projected_total_usd=210.0,
            required_free_usd=10.0,
            candidates=[
                PauseCandidate(
                    "adset", "adset_b", "camp/adset_b", 60.0,
                    "Kill rule triggered: cpa_exceeded", "HIGH",
                ),
            ],
            summary_lines=[
                "Required free budget: $10/day",
                "Suggested pause set frees: $60/day",
                "Note: This is a SAFE-MODE plan (no changes applied).",
            ],
            meta={"confidence": "HIGH"},
        )

        text = reallocation_plan_text(plan)
        assert "Budget reallocation plan (suggested):" in text
        assert "Required free budget: $10/day" in text
        assert "SAFE-MODE" in text
        assert "Pause adset" in text
        assert "camp/adset_b" in text
        assert "Frees: $60/day" in text
        assert "Confidence: HIGH" in text
        assert "cpa_exceeded" in text
        assert "Overall confidence: HIGH" in text

    def test_plan_text_no_candidates(self):
        from packages.agencyu.marketing.budget_reallocation import ReallocationPlan
        from packages.agencyu.messaging.approval_card import reallocation_plan_text

        plan = ReallocationPlan(
            blocked_delta_usd=30.0,
            cap_usd=200.0,
            current_total_usd=180.0,
            projected_total_usd=210.0,
            required_free_usd=10.0,
            candidates=[],
            summary_lines=["Required free budget: $10/day"],
            meta={"confidence": "LOW"},
        )

        text = reallocation_plan_text(plan)
        assert "No pause candidates found" in text


# ══════════════════════════════════════════
# 13. Reallocation Plan Executor Tests
# ══════════════════════════════════════════


class TestReallocationPlanExecutor:

    def _seed_and_plan(self, conn):
        from packages.agencyu.marketing.budget_reallocation import (
            BudgetReallocationPlanner,
        )
        from packages.agencyu.marketing.meta_budget_tracker import MetaBudgetTracker

        tracker = MetaBudgetTracker(
            conn=conn,
            policy={"meta": {"max_daily_budget_cap_usd": 200, "soft_warning_ratio": 0.75}},
        )
        tracker.upsert_budget("fulldigital", "adset", "adset_x", "camp/adset_x", 80.0)
        tracker.upsert_budget("fulldigital", "adset", "adset_y", "camp/adset_y", 60.0)

        planner = BudgetReallocationPlanner(conn=conn)
        plan = planner.suggest_plan(
            brand="fulldigital",
            cap_usd=200.0,
            current_total_usd=140.0,
            delta_usd=70.0,
        )
        return tracker, plan

    def test_execute_safe_mode(self):
        from packages.agencyu.marketing.budget_reallocation import (
            execute_reallocation_plan,
        )

        conn = _make_conn()
        tracker, plan = self._seed_and_plan(conn)

        result = execute_reallocation_plan(
            conn, plan, safe_mode=True, correlation_id="corr_exec_safe",
        )
        assert result["safe_mode"] is True
        assert result["candidates_processed"] >= 1
        assert all(r["action"] == "simulated_pause" for r in result["results"])

        # Budgets should still be active (safe mode)
        snap = tracker.snapshot()
        assert snap.total_daily_budget_usd == 140.0

    def test_execute_live_mode(self):
        from packages.agencyu.marketing.budget_reallocation import (
            execute_reallocation_plan,
        )

        conn = _make_conn()
        tracker, plan = self._seed_and_plan(conn)

        result = execute_reallocation_plan(
            conn, plan, safe_mode=False, correlation_id="corr_exec_live",
        )
        assert result["safe_mode"] is False
        assert all(r["action"] == "paused" for r in result["results"])

        # Budgets should be deactivated
        snap = tracker.snapshot()
        assert snap.total_daily_budget_usd < 140.0

    def test_execute_writes_audit(self):
        import json

        from packages.agencyu.marketing.budget_reallocation import (
            execute_reallocation_plan,
        )

        conn = _make_conn()
        _, plan = self._seed_and_plan(conn)

        execute_reallocation_plan(
            conn, plan, safe_mode=True, correlation_id="corr_audit_test",
        )

        row = conn.execute(
            "SELECT * FROM audit_log WHERE correlation_id = ?",
            ["corr_audit_test"],
        ).fetchone()
        assert row is not None
        assert row["action"] == "reallocation_plan_executed"
        payload = json.loads(row["payload_json"])
        assert payload["safe_mode"] is True
        assert payload["candidates_count"] >= 1


# ══════════════════════════════════════════
# 14. Telegram Bot send_blocked_with_plan Tests
# ══════════════════════════════════════════


class TestTelegramBotBlockedPlan:

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_blocked_with_plan_and_alt_scaling(self, mock_post):
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        result = bot.send_blocked_with_plan(
            chat_id=111,
            card_text="Card text here\nProjected \u2192 BLOCKED",
            plan_text="Budget reallocation plan\n1. Pause adset_x",
            alt_scaling_text="Alternative scaling option\n- Suggested now: +$10/day",
            approve_plan_callback_data="approve_plan:abc",
            approve_partial_callback_data="approve_partial:abc",
            alternate_plan_callback_data="alt_plan:abc",
            cancel_callback_data="cancel:abc",
        )
        assert result.get("ok") is True

        call_json = mock_post.call_args.kwargs["json"]
        text = call_json["text"]
        assert "Card text here" in text
        assert "BLOCKED" in text
        assert "Budget reallocation plan" in text
        assert "Alternative scaling option" in text
        assert "---" in text  # separator

        buttons = call_json["reply_markup"]["inline_keyboard"]
        assert len(buttons) == 2  # two rows
        # Row 1: approve pause + approve partial
        assert "Approve pause plan" in buttons[0][0]["text"]
        assert "Approve partial scale" in buttons[0][1]["text"]
        # Row 2: alternate + cancel
        assert "Alternate plan" in buttons[1][0]["text"]
        assert "Cancel" in buttons[1][1]["text"]

    @patch("packages.agencyu.messaging.telegram_bot.httpx.post")
    def test_send_blocked_without_partial(self, mock_post):
        """Without approve_partial_callback_data, row1 has only pause button."""
        from packages.agencyu.messaging.telegram_bot import TelegramBot

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True}
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        bot = TelegramBot(token="fake", allowed_chat_ids={111})
        bot.send_blocked_with_plan(
            chat_id=111,
            card_text="Card",
            plan_text="Plan",
            approve_plan_callback_data="approve_plan:abc",
            cancel_callback_data="cancel:abc",
        )
        call_json = mock_post.call_args.kwargs["json"]
        buttons = call_json["reply_markup"]["inline_keyboard"]
        assert len(buttons[0]) == 1  # only pause button, no partial


# ══════════════════════════════════════════
# 15. Alternative Scaling Planner Tests
# ══════════════════════════════════════════


class TestAlternativeScalingPlanner:

    def test_plan_partial_scale(self):
        from packages.agencyu.marketing.alternative_scaling import (
            AlternativeScalingPlanner,
        )

        planner = AlternativeScalingPlanner()
        plan = planner.plan(
            cap_usd=200.0,
            current_total_usd=190.0,
            requested_delta_usd=50.0,
        )
        assert plan.delta_now_usd == 10.0
        assert plan.delta_later_usd == 40.0
        assert plan.allowed_delta_now_usd == 10.0
        assert plan.confidence == "HIGH"
        assert plan.next_run_at  # non-empty ISO string

    def test_plan_fully_blocked(self):
        from packages.agencyu.marketing.alternative_scaling import (
            AlternativeScalingPlanner,
        )

        planner = AlternativeScalingPlanner()
        plan = planner.plan(
            cap_usd=200.0,
            current_total_usd=200.0,
            requested_delta_usd=50.0,
        )
        assert plan.delta_now_usd == 0.0
        assert plan.delta_later_usd == 50.0
        assert plan.allowed_delta_now_usd == 0.0

    def test_plan_fits_under_cap(self):
        from packages.agencyu.marketing.alternative_scaling import (
            AlternativeScalingPlanner,
        )

        planner = AlternativeScalingPlanner()
        plan = planner.plan(
            cap_usd=200.0,
            current_total_usd=100.0,
            requested_delta_usd=50.0,
        )
        assert plan.delta_now_usd == 50.0
        assert plan.delta_later_usd == 0.0
        assert "No remainder" in " ".join(plan.summary_lines)

    def test_plan_summary_lines(self):
        from packages.agencyu.marketing.alternative_scaling import (
            AlternativeScalingPlanner,
        )

        planner = AlternativeScalingPlanner()
        plan = planner.plan(
            cap_usd=200.0,
            current_total_usd=190.0,
            requested_delta_usd=30.0,
        )
        summary = "\n".join(plan.summary_lines)
        assert "Requested delta: $30/day" in summary
        assert "Allowed now (under cap): $10/day" in summary
        assert "Suggested now: +$10/day" in summary
        assert "+$20/day (queue for tomorrow)" in summary
        assert "SAFE-MODE" in summary


# ══════════════════════════════════════════
# 16. Alternative Scaling Text Formatter Tests
# ══════════════════════════════════════════


class TestAlternativeScalingText:

    def test_renders_plan(self):
        from packages.agencyu.marketing.alternative_scaling import (
            AlternativeScalingPlan,
        )
        from packages.agencyu.messaging.approval_card import (
            alternative_scaling_text,
        )

        plan = AlternativeScalingPlan(
            requested_delta_usd=50.0,
            allowed_delta_now_usd=10.0,
            delta_now_usd=10.0,
            delta_later_usd=40.0,
            next_run_at="2026-03-08T14:00:00+00:00",
            summary_lines=[
                "Requested delta: $50/day",
                "Allowed now (under cap): $10/day",
                "Suggested now: +$10/day",
                "Suggested later: +$40/day (queue for tomorrow)",
            ],
            confidence="HIGH",
        )
        text = alternative_scaling_text(plan)
        assert "Alternative scaling option (suggested):" in text
        assert "Requested delta: $50/day" in text
        assert "+$10/day" in text
        assert "+$40/day" in text


# ══════════════════════════════════════════
# 17. Scheduler Helper Tests
# ══════════════════════════════════════════


class TestSchedulerHelper:

    def test_enqueue_scheduled_action(self):
        import json

        from packages.agencyu.jobs.scheduler import enqueue_scheduled_action

        conn = _make_conn()
        row_id = enqueue_scheduled_action(
            conn,
            run_at_iso="2026-03-08T14:00:00+00:00",
            action_type="meta.check_remainder_stability",
            brand="fulldigital",
            payload={"delta_usd": 40.0, "risk_level": "high"},
            correlation_id="corr_sched_1",
        )
        assert row_id > 0

        row = conn.execute(
            "SELECT * FROM scheduled_actions WHERE id = ?", [row_id],
        ).fetchone()
        assert row["action_type"] == "meta.check_remainder_stability"
        assert row["status"] == "pending"
        assert row["run_at_iso"] == "2026-03-08T14:00:00+00:00"

        payload = json.loads(row["payload_json"])
        assert payload["delta_usd"] == 40.0
        assert payload["brand"] == "fulldigital"
        assert payload["correlation_id"] == "corr_sched_1"

    def test_enqueue_multiple(self):
        from packages.agencyu.jobs.scheduler import enqueue_scheduled_action

        conn = _make_conn()
        id1 = enqueue_scheduled_action(
            conn,
            run_at_iso="2026-03-08T14:00:00",
            action_type="meta.test_action",
            brand="cutmv",
            payload={"n": 1},
        )
        id2 = enqueue_scheduled_action(
            conn,
            run_at_iso="2026-03-09T14:00:00",
            action_type="meta.test_action",
            brand="cutmv",
            payload={"n": 2},
        )
        assert id2 > id1

        count = conn.execute(
            "SELECT COUNT(*) FROM scheduled_actions",
        ).fetchone()[0]
        assert count == 2


# ══════════════════════════════════════════
# 18. Partial Scale Executor Tests
# ══════════════════════════════════════════


class TestPartialScaleExecutor:

    def test_execute_safe_mode(self):
        from packages.agencyu.marketing.executors.meta_partial_scale import (
            execute_partial_scale_bundle,
        )

        conn = _make_conn()
        result = execute_partial_scale_bundle(
            conn,
            payload={
                "delta_now_usd": 10.0,
                "delta_later_usd": 40.0,
                "next_run_at": "2026-03-08T14:00:00+00:00",
                "brand": "fulldigital",
                "correlation_id": "corr_partial_safe",
                "original_action_payload": {"campaign_id": "camp_1"},
            },
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["safe_mode"] is True
        assert result["delta_now_usd"] == 10.0
        assert result["delta_later_usd"] == 40.0
        assert result["later_queued"] is True

        # Should have audit entries but NO scheduled_actions (safe mode)
        audit_rows = conn.execute(
            "SELECT * FROM audit_log WHERE correlation_id = ?",
            ["corr_partial_safe"],
        ).fetchall()
        assert len(audit_rows) >= 1
        actions = [r["action"] for r in audit_rows]
        assert "meta_partial_scale_simulated" in actions
        assert "meta_scale_remainder_simulated" in actions

        # No scheduled action in safe mode
        sched_count = conn.execute(
            "SELECT COUNT(*) FROM scheduled_actions",
        ).fetchone()[0]
        assert sched_count == 0

    def test_execute_live_mode(self):
        import json

        from packages.agencyu.marketing.executors.meta_partial_scale import (
            execute_partial_scale_bundle,
        )

        conn = _make_conn()
        result = execute_partial_scale_bundle(
            conn,
            payload={
                "delta_now_usd": 10.0,
                "delta_later_usd": 40.0,
                "next_run_at": "2026-03-08T14:00:00+00:00",
                "brand": "fulldigital",
                "correlation_id": "corr_partial_live",
                "original_action_payload": {"campaign_id": "camp_1"},
            },
            safe_mode=False,
        )
        assert result["ok"] is True
        assert result["safe_mode"] is False
        assert result["later_queued"] is True

        # Should have queued a scheduled action
        row = conn.execute(
            "SELECT * FROM scheduled_actions WHERE status = 'pending'",
        ).fetchone()
        assert row is not None
        assert row["action_type"] == "meta.check_remainder_stability"
        payload = json.loads(row["payload_json"])
        assert payload["delta_usd"] == 40.0
        assert payload["brand"] == "fulldigital"

    def test_execute_no_remainder(self):
        from packages.agencyu.marketing.executors.meta_partial_scale import (
            execute_partial_scale_bundle,
        )

        conn = _make_conn()
        result = execute_partial_scale_bundle(
            conn,
            payload={
                "delta_now_usd": 50.0,
                "delta_later_usd": 0.0,
                "brand": "fulldigital",
                "correlation_id": "corr_no_later",
            },
            safe_mode=True,
        )
        assert result["ok"] is True
        assert result["later_queued"] is False


# ══════════════════════════════════════════
# 19. Stability Gate Tests
# ══════════════════════════════════════════


class TestStabilityGate:

    GATE_POLICY = {
        "stability_gate": {
            "enabled": True,
            "lookback_days": 2,
            "min_spend_usd": 30,
            "min_conversions": 2,
            "max_cpa_increase_ratio": 1.25,
            "min_roas_ratio_of_baseline": 0.85,
            "max_fatigue_score": 0.70,
            "fulldigital": {
                "min_calls_observed": 10,
                "min_pipeline_quality": 0.60,
                "min_close_rate": 0.05,
            },
            "on_fail": {
                "notify_telegram": True,
                "keep_scheduled_action": False,
            },
        },
    }

    def _make_store(self, now_metrics, base_metrics):
        store = MagicMock()
        store.get_combo_metrics.side_effect = lambda combo_id, brand, window: (
            now_metrics if "last_24h" in window else base_metrics
        )
        return store

    def test_stable_combo_passes(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {"spend_usd": 60, "conversions": 5, "cpa": 12, "roas": 2.5, "fatigue_score": 0.3}
        base = {"spend_usd": 50, "conversions": 4, "cpa": 11, "roas": 2.6}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="cutmv", combo_id="combo_14")
        assert result.ok is True
        assert len(result.reasons) == 0
        assert result.confidence in ("MED", "HIGH")

    def test_cpa_worsened_fails(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {"spend_usd": 60, "conversions": 5, "cpa": 20, "roas": 2.0, "fatigue_score": 0.3}
        base = {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.5}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="cutmv", combo_id="combo_14")
        assert result.ok is False
        assert any("CPA worsened" in r for r in result.reasons)

    def test_roas_dropped_fails(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {"spend_usd": 60, "conversions": 5, "cpa": 11, "roas": 1.0, "fatigue_score": 0.3}
        base = {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.5}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="cutmv", combo_id="combo_14")
        assert result.ok is False
        assert any("ROAS dropped" in r for r in result.reasons)

    def test_fatigue_high_fails(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {"spend_usd": 60, "conversions": 5, "cpa": 11, "roas": 2.5, "fatigue_score": 0.85}
        base = {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.5}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="cutmv", combo_id="combo_14")
        assert result.ok is False
        assert any("fatigue" in r.lower() for r in result.reasons)

    def test_no_store_fails_safe(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=None)
        result = gate.evaluate(brand="cutmv", combo_id="combo_14")
        assert result.ok is False
        assert any("Insufficient" in r for r in result.reasons)
        assert result.confidence == "LOW"

    def test_low_spend_fails(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {"spend_usd": 10, "conversions": 1, "cpa": 10, "roas": 2.0}
        base = {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.0}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="cutmv", combo_id="combo_14")
        assert result.ok is False
        assert any("Spend below" in r for r in result.reasons)
        assert any("Conversions below" in r for r in result.reasons)

    def test_fulldigital_pipeline_quality_fails(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {
            "spend_usd": 60, "conversions": 5, "cpa": 11, "roas": 2.5,
            "fatigue_score": 0.3, "calls_observed": 15,
            "pipeline_quality": 0.40, "close_rate": 0.02,
        }
        base = {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.5}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="fulldigital", combo_id="combo_fd_1")
        assert result.ok is False
        assert any("Pipeline quality" in r for r in result.reasons)
        assert any("Close rate" in r for r in result.reasons)

    def test_fulldigital_skips_pipeline_check_if_few_calls(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {
            "spend_usd": 60, "conversions": 5, "cpa": 11, "roas": 2.5,
            "fatigue_score": 0.3, "calls_observed": 3,
            "pipeline_quality": 0.10, "close_rate": 0.01,
        }
        base = {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.5}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="fulldigital", combo_id="combo_fd_2")
        # Should pass — not enough calls to evaluate pipeline
        assert result.ok is True

    def test_high_confidence_with_large_sample(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        now = {"spend_usd": 120, "conversions": 10, "cpa": 11, "roas": 2.5, "fatigue_score": 0.2}
        base = {"spend_usd": 100, "conversions": 8, "cpa": 10, "roas": 2.5}
        store = self._make_store(now, base)

        gate = StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)
        result = gate.evaluate(brand="cutmv", combo_id="combo_14")
        assert result.ok is True
        assert result.confidence == "HIGH"


# ══════════════════════════════════════════
# 20. Remainder Stability Job Tests
# ══════════════════════════════════════════


class TestRemainderStabilityJob:

    GATE_POLICY = TestStabilityGate.GATE_POLICY

    def _make_action_row(self, conn, payload_dict):
        from packages.agencyu.jobs.scheduler import enqueue_scheduled_action

        row_id = enqueue_scheduled_action(
            conn,
            run_at_iso="2026-03-08T14:00:00+00:00",
            action_type="meta.check_remainder_stability",
            brand=payload_dict.get("brand", "fulldigital"),
            payload=payload_dict,
            correlation_id=payload_dict.get("correlation_id", ""),
        )
        row = conn.execute(
            "SELECT * FROM scheduled_actions WHERE id = ?", [row_id],
        ).fetchone()
        return dict(row)

    def _make_stable_gate(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        store = MagicMock()
        store.get_combo_metrics.side_effect = lambda combo_id, brand, window: (
            {"spend_usd": 60, "conversions": 5, "cpa": 11, "roas": 2.5, "fatigue_score": 0.2}
            if "last_24h" in window
            else {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.5}
        )
        return StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)

    def _make_unstable_gate(self):
        from packages.agencyu.marketing.stability_gate import StabilityGate

        store = MagicMock()
        store.get_combo_metrics.side_effect = lambda combo_id, brand, window: (
            {"spend_usd": 60, "conversions": 5, "cpa": 30, "roas": 0.5, "fatigue_score": 0.85}
            if "last_24h" in window
            else {"spend_usd": 50, "conversions": 4, "cpa": 10, "roas": 2.5}
        )
        return StabilityGate(policy=self.GATE_POLICY, combo_metrics_store=store)

    def test_stable_requests_approval(self):
        from packages.agencyu.marketing.jobs.remainder_stability_job import (
            run_remainder_stability_check,
        )

        conn = _make_conn()
        action_row = self._make_action_row(conn, {
            "brand": "cutmv",
            "combo_id": "combo_14",
            "delta_usd": 40.0,
            "correlation_id": "corr_stable",
        })

        result = run_remainder_stability_check(
            conn=conn,
            policy=self.GATE_POLICY,
            stability_gate=self._make_stable_gate(),
            action_row=action_row,
        )
        assert result["requested_approval"] is True
        assert result["approval_payload"]["action_type"] == "meta.request_scale_remainder_approval"
        assert result["approval_payload"]["estimated_spend_impact_usd"] == 40.0

        # Scheduled action should be PASSED
        row = conn.execute(
            "SELECT status FROM scheduled_actions WHERE id = ?",
            [action_row["id"]],
        ).fetchone()
        assert row["status"] == "PASSED"

    def test_unstable_skips(self):
        from packages.agencyu.marketing.jobs.remainder_stability_job import (
            run_remainder_stability_check,
        )

        conn = _make_conn()
        action_row = self._make_action_row(conn, {
            "brand": "cutmv",
            "combo_id": "combo_14",
            "delta_usd": 40.0,
            "correlation_id": "corr_unstable",
        })

        result = run_remainder_stability_check(
            conn=conn,
            policy=self.GATE_POLICY,
            stability_gate=self._make_unstable_gate(),
            action_row=action_row,
        )
        assert result["skipped"] is True
        assert len(result["reasons"]) >= 1
        assert "telegram_text" in result

        # Scheduled action should be SKIPPED
        row = conn.execute(
            "SELECT status FROM scheduled_actions WHERE id = ?",
            [action_row["id"]],
        ).fetchone()
        assert row["status"] == "SKIPPED"

    def test_unstable_telegram_text(self):
        from packages.agencyu.marketing.jobs.remainder_stability_job import (
            run_remainder_stability_check,
        )

        conn = _make_conn()
        action_row = self._make_action_row(conn, {
            "brand": "cutmv",
            "combo_id": "combo_14",
            "delta_usd": 40.0,
            "correlation_id": "corr_tg",
        })

        result = run_remainder_stability_check(
            conn=conn,
            policy=self.GATE_POLICY,
            stability_gate=self._make_unstable_gate(),
            action_row=action_row,
        )
        text = result["telegram_text"]
        assert "skipped" in text.lower()
        assert "combo_14" in text
        assert "$40/day" in text

    def test_gate_disabled_proceeds(self):
        from packages.agencyu.marketing.jobs.remainder_stability_job import (
            run_remainder_stability_check,
        )

        conn = _make_conn()
        disabled_policy = {"stability_gate": {"enabled": False}}
        action_row = self._make_action_row(conn, {
            "brand": "cutmv",
            "combo_id": "combo_14",
            "delta_usd": 40.0,
            "correlation_id": "corr_disabled",
        })

        result = run_remainder_stability_check(
            conn=conn,
            policy=disabled_policy,
            stability_gate=self._make_unstable_gate(),  # gate would fail, but disabled
            action_row=action_row,
        )
        assert result["requested_approval"] is True

    def test_writes_audit_on_evaluation(self):
        from packages.agencyu.marketing.jobs.remainder_stability_job import (
            run_remainder_stability_check,
        )

        conn = _make_conn()
        action_row = self._make_action_row(conn, {
            "brand": "cutmv",
            "combo_id": "combo_14",
            "delta_usd": 40.0,
            "correlation_id": "corr_audit_gate",
        })

        run_remainder_stability_check(
            conn=conn,
            policy=self.GATE_POLICY,
            stability_gate=self._make_stable_gate(),
            action_row=action_row,
        )

        row = conn.execute(
            "SELECT * FROM audit_log WHERE action = 'stability_gate_evaluated'",
        ).fetchone()
        assert row is not None
        import json
        payload = json.loads(row["payload_json"])
        assert payload["ok"] is True
        assert payload["combo_id"] == "combo_14"
