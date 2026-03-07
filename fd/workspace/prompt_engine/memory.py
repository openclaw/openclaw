"""Conversation memory — multi-turn context and persistent notes.

Two layers:
  1. **ConversationStore** — short-lived per-session turn history so the
     engine can reference what was said earlier in the same conversation.
  2. **NoteStore** — longer-lived key-value notes (e.g. "last brand used",
     "preferred report format") that persist across sessions.

Both stores are in-memory by default.  Swap in SQLite or Redis backends
for production durability.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Turn:
    """A single conversational turn."""

    role: str  # "user" or "assistant"
    text: str
    ts: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)


class ConversationStore:
    """In-memory per-conversation turn history with a sliding window."""

    def __init__(self, max_turns: int = 20):
        self._max_turns = max_turns
        self._conversations: dict[str, list[Turn]] = defaultdict(list)

    def add_turn(self, conversation_id: str, role: str, text: str, **meta: Any) -> None:
        turns = self._conversations[conversation_id]
        turns.append(Turn(role=role, text=text, metadata=meta))
        # Slide window
        if len(turns) > self._max_turns:
            self._conversations[conversation_id] = turns[-self._max_turns :]

    def get_history(self, conversation_id: str, last_n: int | None = None) -> list[Turn]:
        turns = self._conversations.get(conversation_id, [])
        if last_n is not None:
            return turns[-last_n:]
        return list(turns)

    def last_user_turn(self, conversation_id: str) -> Turn | None:
        for turn in reversed(self._conversations.get(conversation_id, [])):
            if turn.role == "user":
                return turn
        return None

    def clear(self, conversation_id: str) -> None:
        self._conversations.pop(conversation_id, None)


class NoteStore:
    """Key-value notes scoped to (user, brand).

    Use cases:
      - Remember the last brand the user was working with
      - Store user preferences ("always show plan previews")
      - Cache workflow-specific context between sessions
    """

    def __init__(self) -> None:
        self._notes: dict[str, dict[str, str]] = defaultdict(dict)

    def set(self, scope: str, key: str, value: str) -> None:
        self._notes[scope][key] = value

    def get(self, scope: str, key: str) -> str | None:
        return self._notes.get(scope, {}).get(key)

    def get_all(self, scope: str) -> dict[str, str]:
        return dict(self._notes.get(scope, {}))

    def get_relevant_notes(
        self,
        *,
        brand: str | None = None,
        workflow: str | None = None,
    ) -> list[str]:
        """Return notes relevant to the current brand/workflow context."""
        results: list[str] = []
        if brand:
            results.extend(
                f"{k}: {v}" for k, v in self._notes.get(f"brand:{brand}", {}).items()
            )
        if workflow:
            results.extend(
                f"{k}: {v}" for k, v in self._notes.get(f"workflow:{workflow}", {}).items()
            )
        return results

    def delete(self, scope: str, key: str) -> None:
        self._notes.get(scope, {}).pop(key, None)
