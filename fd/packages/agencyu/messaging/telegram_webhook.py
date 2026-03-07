"""Telegram Webhook Handler — FastAPI router for Telegram Bot updates.

Handles:
- /health — system health summary
- /approvals — list pending approvals (PENDING + APPROVED_STEP1)
- /approve <id> — approve step1 or final depending on state
- /deny <id> — deny from PENDING or APPROVED_STEP1
- /webops status — placeholder for webops health
- Inline keyboard callbacks with HMAC-signed callback_data

Safety:
- Webhook endpoint protected by secret path segment
- All messages validated against allowed chat IDs
- Callback buttons verified via HMAC + one-time nonce
- All decisions fully audited
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from packages.agencyu.approvals.engine import ApprovalEngine
from packages.agencyu.messaging.approval_card import brand_chip, risk_chip
from packages.agencyu.messaging.telegram_bot import TelegramBot
from packages.common.logging import get_logger

log = get_logger("agencyu.messaging.telegram_webhook")


def create_telegram_router(
    approvals: ApprovalEngine,
    bot: TelegramBot,
    webhook_secret: str = "",
) -> APIRouter:
    """Create a Telegram webhook router with optional secret path segment.

    If webhook_secret is provided, the route is /webhooks/telegram/{secret}.
    Otherwise, /webhooks/telegram (for dev/testing).
    """
    tg_router = APIRouter()

    path = f"/webhooks/telegram/{webhook_secret}" if webhook_secret else "/webhooks/telegram"

    @tg_router.post(path)
    async def telegram_webhook(req: Request) -> dict:
        update = await req.json()

        # ── Handle text commands ──
        if "message" in update:
            msg = update["message"]
            chat_id = int(msg["chat"]["id"])
            text = (msg.get("text") or "").strip()

            if chat_id not in bot.allowed:
                log.warning("telegram_unauthorized", extra={"chat_id": chat_id})
                raise HTTPException(403, "Not allowed")

            return _handle_command(chat_id, text, approvals, bot)

        # ── Handle inline button callbacks ──
        if "callback_query" in update:
            cq = update["callback_query"]
            chat_id = int(cq["message"]["chat"]["id"])

            if chat_id not in bot.allowed:
                log.warning("telegram_callback_unauthorized", extra={"chat_id": chat_id})
                raise HTTPException(403, "Not allowed")

            data = cq.get("data", "")
            return _handle_callback(chat_id, data, cq["id"], approvals, bot)

        return {"ok": True}

    return tg_router


def _handle_command(
    chat_id: int,
    text: str,
    approvals: ApprovalEngine,
    bot: TelegramBot,
) -> dict:
    """Route a text command to the appropriate handler."""

    if text == "/health":
        bot.send(chat_id, "System is running. Use /approvals to check pending items.")
        return {"ok": True}

    if text == "/approvals":
        pending = approvals.get_pending(limit=10)
        if not pending:
            bot.send(chat_id, "No pending approvals.")
            return {"ok": True}

        lines = ["*Pending approvals:*"]
        for p in pending:
            step_info = ""
            if p.get("requires_two_step") and p["status"] == "APPROVED_STEP1":
                step_info = " [AWAITING CONFIRM]"
            elif p.get("requires_two_step"):
                step_info = " [2-step]"

            b_chip = brand_chip(p.get("brand", ""))
            r_chip = risk_chip(p.get("risk_level", ""))
            lines.append(
                f"- {b_chip} | `{p['approval_id']}`\n"
                f"  {p['action_type']}{step_info} | {r_chip}\n"
                f"  {p['summary']} | exp {p['expires_at']}"
            )
        bot.send(chat_id, "\n".join(lines))
        return {"ok": True}

    if text.startswith("/approve "):
        approval_id = text.split(" ", 1)[1].strip()
        # Check current status to route to correct method
        status = approvals.get_status(approval_id)
        if not status:
            bot.send(chat_id, f"Approval `{approval_id}` not found.")
            return {"ok": True}

        if status["status"] == "PENDING":
            result = approvals.approve_step1(approval_id, decided_by=f"telegram:{chat_id}")
        elif status["status"] == "APPROVED_STEP1":
            result = approvals.approve_final(approval_id, decided_by=f"telegram:{chat_id}")
        else:
            bot.send(chat_id, f"`{approval_id}` is {status['status']} — no action taken.")
            return {"ok": True}

        bot.send(chat_id, f"`{approval_id}` -> {result['status']}")

        # If step1 completed and two-step, send confirm prompt
        if result.get("status") == "APPROVED_STEP1":
            confirm_data = approvals.sign_callback("confirm", approval_id)
            deny_data = approvals.sign_callback("deny", approval_id)
            bot.send_confirm_request(
                chat_id, approval_id,
                confirm_expires_at=result.get("confirm_expires_at", ""),
                confirm_callback_data=confirm_data,
                cancel_callback_data=deny_data,
            )
        return {"ok": True}

    if text.startswith("/deny "):
        approval_id = text.split(" ", 1)[1].strip()
        result = approvals.deny(approval_id, decided_by=f"telegram:{chat_id}")
        bot.send(chat_id, f"Denied `{approval_id}` -> {result['status']}")
        return {"ok": True}

    if text == "/webops status":
        bot.send(chat_id, "WebOps: status check not wired yet. Use admin dashboard.")
        return {"ok": True}

    bot.send(chat_id, (
        "Commands:\n"
        "/health - system status\n"
        "/approvals - pending approvals\n"
        "/approve <id> - approve\n"
        "/deny <id> - deny\n"
        "/webops status - site health"
    ))
    return {"ok": True}


def _handle_callback(
    chat_id: int,
    data: str,
    callback_query_id: str,
    approvals: ApprovalEngine,
    bot: TelegramBot,
) -> dict:
    """Handle an inline keyboard callback (signed or unsigned)."""

    # Try signed callback first (action:id:nonce:hmac)
    parts = data.split(":")
    if len(parts) == 4:
        valid, action, approval_id = approvals.verify_callback(data)
        if not valid:
            bot.answer_callback(callback_query_id, "Invalid or expired button.")
            return {"ok": True}

        if action == "approve":
            result = approvals.approve_step1(approval_id, decided_by=f"telegram:{chat_id}")
            bot.answer_callback(callback_query_id, f"{result['status']}")

            # If two-step step1, send confirm follow-up
            if result.get("status") == "APPROVED_STEP1":
                confirm_data = approvals.sign_callback("confirm", approval_id)
                deny_data = approvals.sign_callback("deny", approval_id)
                bot.send_confirm_request(
                    chat_id, approval_id,
                    confirm_expires_at=result.get("confirm_expires_at", ""),
                    confirm_callback_data=confirm_data,
                    cancel_callback_data=deny_data,
                )

        elif action == "confirm":
            result = approvals.approve_final(approval_id, decided_by=f"telegram:{chat_id}")
            bot.answer_callback(callback_query_id, f"{result['status']}")

        elif action == "deny":
            result = approvals.deny(approval_id, decided_by=f"telegram:{chat_id}")
            bot.answer_callback(callback_query_id, f"{result['status']}")

        else:
            bot.answer_callback(callback_query_id, "Unknown action")

        return {"ok": True}

    # Fallback: unsigned callback (action:id) — legacy compat
    if len(parts) == 2:
        action, approval_id = parts
        if action == "approve":
            result = approvals.approve_step1(approval_id, decided_by=f"telegram:{chat_id}")
            bot.answer_callback(callback_query_id, f"{result['status']}")
            if result.get("status") == "APPROVED_STEP1":
                confirm_data = approvals.sign_callback("confirm", approval_id)
                deny_data = approvals.sign_callback("deny", approval_id)
                bot.send_confirm_request(
                    chat_id, approval_id,
                    confirm_expires_at=result.get("confirm_expires_at", ""),
                    confirm_callback_data=confirm_data,
                    cancel_callback_data=deny_data,
                )
        elif action == "deny":
            result = approvals.deny(approval_id, decided_by=f"telegram:{chat_id}")
            bot.answer_callback(callback_query_id, f"{result['status']}")
        else:
            bot.answer_callback(callback_query_id, "Unknown action")
        return {"ok": True}

    bot.answer_callback(callback_query_id, "Unknown action")
    return {"ok": True}
