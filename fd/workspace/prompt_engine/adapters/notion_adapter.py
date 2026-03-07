"""Notion adapter — bridges Notion action surfaces to the engine.

Notion-based control surfaces (e.g. an "Ask OpenClaw" database row or
inline action button) post structured payloads.  This adapter normalises
them into :class:`UserPrompt` objects and can write results back to
Notion pages/databases.
"""

from __future__ import annotations

from typing import Any, Protocol

from openclaw.prompt_engine.engine import OpenClawPromptEngine
from openclaw.prompt_engine.types import EngineResponse, UserPrompt


class NotionClient(Protocol):
    """Minimal protocol for writing results back to Notion."""
    def update_page(self, page_id: str, properties: dict[str, Any]) -> Any: ...
    def append_block(self, page_id: str, content: str) -> Any: ...


class NotionPromptAdapter:
    """Bridges Notion action surfaces to the OpenClaw Prompt Engine."""

    def __init__(self, engine: OpenClawPromptEngine, notion_client: NotionClient | None = None):
        self.engine = engine
        self.notion = notion_client

    def handle_action(
        self,
        page_id: str,
        user_id: str,
        text: str,
        brand_hint: str | None = None,
    ) -> EngineResponse:
        prompt = UserPrompt(
            text=text,
            channel="notion",
            user_id=user_id,
            brand_hint=brand_hint,
            conversation_id=f"notion:{page_id}",
            metadata={"notion_page_id": page_id},
        )

        response = self.engine.handle(prompt)

        # Write result back to Notion page if client is wired
        if self.notion and response.ok:
            self.notion.append_block(page_id, response.reply)

        return response
