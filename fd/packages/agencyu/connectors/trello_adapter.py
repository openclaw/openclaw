from __future__ import annotations

from typing import Any

from packages.common.logging import get_logger

log = get_logger("agencyu.connectors.trello_adapter")


class TrelloAdapter:
    """Adapter stub for Trello board/card discovery.

    Uses the existing Trello integration client under the hood.
    Concrete implementation deferred to when Trello→Notion mirroring is activated.
    """

    def __init__(self, api_key: str = "", token: str = "") -> None:
        self.api_key = api_key
        self.token = token

    def list_boards(self) -> list[dict[str, Any]]:
        """List all Trello boards accessible to the token."""
        raise NotImplementedError("Trello board listing not yet implemented")

    def list_cards(self, board_id: str) -> list[dict[str, Any]]:
        """List all cards on a Trello board."""
        raise NotImplementedError("Trello card listing not yet implemented")

    def list_lists(self, board_id: str) -> list[dict[str, Any]]:
        """List all lists on a Trello board."""
        raise NotImplementedError("Trello list listing not yet implemented")

    def card_to_canonical(self, card: dict[str, Any], list_name: str | None = None) -> dict[str, Any]:
        """Convert a Trello card to canonical Task data."""
        return {
            "name": card.get("name", ""),
            "description": card.get("desc", ""),
            "status": list_name or "Unknown",
            "due_date": card.get("due"),
            "members": [m.get("id") for m in card.get("members", [])],
            "labels": [lb.get("name", "") for lb in card.get("labels", [])],
            "trello_url": card.get("url", ""),
            "trello_card_id": card.get("id", ""),
            "trello_board_id": card.get("idBoard", ""),
            "last_activity": card.get("dateLastActivity"),
        }
