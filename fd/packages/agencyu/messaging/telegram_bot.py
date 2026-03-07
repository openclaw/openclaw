"""Telegram Bot — notification + control plane for OpenClaw.

Supports:
- Sending alerts (health, approvals, marketing, webops)
- Inline keyboard buttons with HMAC-signed callback_data
- Rate-limited, chat-ID-allowlisted, fully audited
- Burst coalescing (one message per cooldown window with summary)

Safety:
- Only accepts messages from TELEGRAM_ALLOWED_CHAT_IDS
- Callback buttons are signed with HMAC (anti-forgery + anti-replay)
- All approval actions are time-limited, idempotent, logged
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from packages.common.logging import get_logger

log = get_logger("agencyu.messaging.telegram_bot")

# ── Rate limiter ──

_rate_state: dict[str, float] = {}
MIN_INTERVAL_SECONDS = 1.0

# ── Burst coalescing ──
_burst_buffer: dict[int, list[str]] = {}  # chat_id -> queued messages
_burst_last_flush: dict[int, float] = {}
BURST_COOLDOWN_SECONDS = 5.0


def _rate_limit(action: str) -> None:
    """Enforce MIN_INTERVAL_SECONDS between calls of the same action."""
    now = time.monotonic()
    last = _rate_state.get(action, 0.0)
    wait = MIN_INTERVAL_SECONDS - (now - last)
    if wait > 0:
        time.sleep(wait)
    _rate_state[action] = time.monotonic()


class TelegramBot:
    """Thin Telegram Bot API wrapper with safety guardrails and signed callbacks."""

    def __init__(
        self,
        token: str,
        allowed_chat_ids: set[int],
    ) -> None:
        self.token = token
        self.allowed = allowed_chat_ids
        self.base = f"https://api.telegram.org/bot{token}"

    def send(
        self,
        chat_id: int,
        text: str,
        buttons: list[list[dict[str, str]]] | None = None,
    ) -> dict[str, Any]:
        """Send a message to an allowed chat ID."""
        if chat_id not in self.allowed:
            log.warning("telegram_send_blocked", extra={"chat_id": chat_id})
            return {"skipped": True, "reason": "chat_id not allowed"}

        _rate_limit("telegram.send")
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }
        if buttons:
            payload["reply_markup"] = {"inline_keyboard": buttons}

        try:
            r = httpx.post(
                f"{self.base}/sendMessage",
                json=payload,
                timeout=20,
            )
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            log.error("telegram_send_error", extra={"error": str(exc), "chat_id": chat_id})
            return {"error": str(exc)}

    def send_burst(self, chat_id: int, text: str) -> dict[str, Any] | None:
        """Buffer a message for burst coalescing.

        Flushes immediately if cooldown has passed, otherwise buffers.
        Returns send result on flush, None if buffered.
        """
        now = time.monotonic()
        last = _burst_last_flush.get(chat_id, 0.0)

        if now - last >= BURST_COOLDOWN_SECONDS:
            # Flush any buffered + this new message
            buf = _burst_buffer.pop(chat_id, [])
            buf.append(text)
            combined = "\n---\n".join(buf)
            _burst_last_flush[chat_id] = now
            return self.send(chat_id, combined)

        # Buffer
        _burst_buffer.setdefault(chat_id, []).append(text)
        return None

    def flush_burst(self, chat_id: int) -> dict[str, Any] | None:
        """Force flush any buffered burst messages."""
        buf = _burst_buffer.pop(chat_id, [])
        if not buf:
            return None
        _burst_last_flush[chat_id] = time.monotonic()
        return self.send(chat_id, "\n---\n".join(buf))

    def answer_callback(self, callback_query_id: str, text: str) -> dict[str, Any]:
        """Answer an inline keyboard callback query."""
        _rate_limit("telegram.answerCallback")
        try:
            r = httpx.post(
                f"{self.base}/answerCallbackQuery",
                json={"callback_query_id": callback_query_id, "text": text},
                timeout=20,
            )
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            log.error("telegram_callback_error", extra={"error": str(exc)})
            return {"error": str(exc)}

    def send_approval_request(
        self,
        chat_id: int,
        approval_id: str,
        action_type: str,
        summary: str,
        expires_at: str,
        requires_two_step: bool = False,
        risk_level: str = "high",
        brand: str = "",
        approve_callback_data: str = "",
        deny_callback_data: str = "",
        estimated_spend_impact_usd: float = 0.0,
        why_now: str = "",
        rollback_plan: str = "",
        correlation_id: str = "",
        confirm_expires_at: str | None = None,
        max_daily_spend_hard_cap_usd: float | None = None,
        meta_budget_snapshot: Any = None,
    ) -> dict[str, Any]:
        """Send an approval request with rich card and signed inline buttons."""
        from packages.agencyu.messaging.approval_card import approval_card_text

        text = approval_card_text(
            approval_id=approval_id,
            action_type=action_type,
            brand=brand or "unknown",
            estimated_spend_impact_usd=estimated_spend_impact_usd,
            risk_level=risk_level,
            why_now=why_now or summary,
            rollback_plan=rollback_plan or "See executor rollback procedure",
            expires_at=expires_at,
            requires_two_step=requires_two_step,
            confirm_expires_at=confirm_expires_at,
            correlation_id=correlation_id,
            max_daily_spend_hard_cap_usd=max_daily_spend_hard_cap_usd,
            meta_budget_snapshot=meta_budget_snapshot,
        )

        # Use signed callbacks if provided, otherwise raw
        approve_data = approve_callback_data or f"approve:{approval_id}"
        deny_data = deny_callback_data or f"deny:{approval_id}"

        buttons = [[
            {"text": "\u2705 Approve", "callback_data": approve_data},
            {"text": "\u274c Deny", "callback_data": deny_data},
        ]]
        return self.send(chat_id, text, buttons=buttons)

    def send_blocked_with_plan(
        self,
        chat_id: int,
        card_text: str,
        plan_text: str,
        alt_scaling_text: str = "",
        approve_plan_callback_data: str = "",
        approve_partial_callback_data: str = "",
        alternate_plan_callback_data: str = "",
        cancel_callback_data: str = "",
    ) -> dict[str, Any]:
        """Send a BLOCKED approval card with reallocation + alt-scaling plans.

        Combines card_text, plan_text, and alt_scaling_text into one message
        with up to 4 action buttons across two rows.
        """
        parts = [card_text, plan_text]
        if alt_scaling_text:
            parts.append(alt_scaling_text)
        combined = "\n\n---\n\n".join(parts)

        row1 = [
            {
                "text": "\U0001f9fe Approve pause plan",
                "callback_data": approve_plan_callback_data or "noop",
            },
        ]
        if approve_partial_callback_data:
            row1.append({
                "text": "\u2705 Approve partial scale",
                "callback_data": approve_partial_callback_data,
            })

        row2 = [
            {
                "text": "\U0001f9e0 Alternate plan",
                "callback_data": alternate_plan_callback_data or "noop",
            },
            {
                "text": "\u274c Cancel",
                "callback_data": cancel_callback_data or "noop",
            },
        ]
        return self.send(chat_id, combined, buttons=[row1, row2])

    def send_confirm_request(
        self,
        chat_id: int,
        approval_id: str,
        confirm_expires_at: str,
        confirm_callback_data: str = "",
        cancel_callback_data: str = "",
    ) -> dict[str, Any]:
        """Send a two-step confirmation follow-up with Confirm/Cancel buttons."""
        text = (
            f"*High-risk action. Confirm?*\n"
            f"ID: `{approval_id}`\n"
            f"Confirm by: {confirm_expires_at}"
        )

        confirm_data = confirm_callback_data or f"confirm:{approval_id}"
        cancel_data = cancel_callback_data or f"deny:{approval_id}"

        buttons = [[
            {"text": "\u2705 Confirm", "callback_data": confirm_data},
            {"text": "\u274c Cancel", "callback_data": cancel_data},
        ]]
        return self.send(chat_id, text, buttons=buttons)
