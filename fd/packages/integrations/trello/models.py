from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TrelloCardRef:
    board_id: str
    card_id: str
    list_id: str
    list_name: str
    card_name: str
    card_desc: str
    card_url: str | None = None
