from __future__ import annotations

from pathlib import Path
from typing import Any

from scripts.memory_hub.jsonio import append_jsonl, write_json
from scripts.memory_hub.paths import hub_paths


def append_event(root: Path, event: dict[str, Any]) -> None:
    append_jsonl(hub_paths(root)["events"], event)


def write_candidate(root: Path, record: dict[str, Any]) -> Path:
    path = hub_paths(root)["candidates"] / f"{record['memory_id']}.json"
    write_json(path, record)
    return path


def write_active_memory(root: Path, record: dict[str, Any]) -> Path:
    path = hub_paths(root)["active"] / f"{record['memory_id']}.json"
    write_json(path, record)
    return path


def write_superseded_memory(root: Path, record: dict[str, Any]) -> Path:
    path = hub_paths(root)["superseded"] / f"{record['memory_id']}.json"
    write_json(path, record)
    return path


def append_review_item(root: Path, item: dict[str, Any]) -> None:
    append_jsonl(hub_paths(root)["review_queue"], item)


def append_audit_entry(root: Path, item: dict[str, Any]) -> None:
    append_jsonl(hub_paths(root)["audit"], item)
