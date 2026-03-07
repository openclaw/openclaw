"""Telegram adapter — thin wrapper between Telegram messages and the engine.

The adapter converts Telegram-specific message objects into a
:class:`UserPrompt` and sends the engine's reply back to the chat.
"""

from __future__ import annotations

from typing import Any, Protocol

from openclaw.prompt_engine.engine import OpenClawPromptEngine
from openclaw.prompt_engine.types import EngineResponse, UserPrompt


class TelegramBot(Protocol):
    """Minimal protocol for the Telegram bot client."""
    def send_text(self, chat_id: str, text: str) -> Any: ...


class TelegramPromptAdapter:
    """Bridges Telegram messages to the OpenClaw Prompt Engine."""

    def __init__(self, engine: OpenClawPromptEngine, telegram_bot: TelegramBot):
        self.engine = engine
        self.bot = telegram_bot

    def handle_message(
        self,
        chat_id: str,
        user_id: str,
        text: str,
        brand_hint: str | None = None,
    ) -> EngineResponse:
        prompt = UserPrompt(
            text=text,
            channel="telegram",
            user_id=user_id,
            chat_id=chat_id,
            brand_hint=brand_hint,
            conversation_id=f"tg:{chat_id}",
        )

        response = self.engine.handle(prompt)
        self.bot.send_text(chat_id, response.reply)
        return response
