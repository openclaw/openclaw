"""Local checkpoint store interface for fixture replay and future live sync."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Protocol

from .models import GmailMediaItem


class CheckpointStore(Protocol):
    def is_processed(self, dedupe_key: str) -> bool: ...

    def mark_processed(self, item: GmailMediaItem) -> None: ...

    def record_failure(self, *, source_ref: str, reason: str) -> None: ...

    def get_history_id(self) -> str | None: ...

    def set_history_id(self, history_id: str | None) -> None: ...


class NullCheckpointStore:
    def is_processed(self, dedupe_key: str) -> bool:
        return False

    def mark_processed(self, item: GmailMediaItem) -> None:
        return None

    def record_failure(self, *, source_ref: str, reason: str) -> None:
        return None

    def get_history_id(self) -> str | None:
        return None

    def set_history_id(self, history_id: str | None) -> None:
        return None


class JsonCheckpointStore:
    """Small durable JSON checkpoint store.

    It is intentionally local-only and carries a history checkpoint field for a
    future read-only Gmail adapter, but v0 never contacts Gmail.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._state = self._load()

    def is_processed(self, dedupe_key: str) -> bool:
        return dedupe_key in self._state["processed"]

    def mark_processed(self, item: GmailMediaItem) -> None:
        self._state["processed"][item.dedupe_key] = {
            "gmail_message_id": item.gmail_message_id,
            "gmail_thread_id": item.gmail_thread_id,
            "rfc822_message_id": item.rfc822_message_id,
            "ingestion_run_id": item.ingestion_run_id,
            "body_sha256": item.body_sha256,
        }
        self._save()

    def record_failure(self, *, source_ref: str, reason: str) -> None:
        self._state["failures"].append({"source_ref": source_ref, "reason": reason})
        self._save()

    def get_history_id(self) -> str | None:
        value = self._state.get("history_id")
        return value if isinstance(value, str) else None

    def set_history_id(self, history_id: str | None) -> None:
        self._state["history_id"] = history_id
        self._save()

    def _load(self) -> dict[str, object]:
        if not self.path.exists():
            return _empty_state()
        with self.path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
        state = _empty_state()
        if isinstance(raw, dict):
            if isinstance(raw.get("history_id"), str) or raw.get("history_id") is None:
                state["history_id"] = raw.get("history_id")
            if isinstance(raw.get("processed"), dict):
                state["processed"] = raw["processed"]
            if isinstance(raw.get("failures"), list):
                state["failures"] = raw["failures"]
        return state

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(f"{self.path.suffix}.tmp")
        with tmp.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(self._state, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
        os.replace(tmp, self.path)


def _empty_state() -> dict[str, object]:
    return {
        "schema_name": "gmail_media_sidecar_checkpoint",
        "schema_version": "0.1.0",
        "history_id": None,
        "processed": {},
        "failures": [],
    }
