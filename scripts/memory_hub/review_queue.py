from __future__ import annotations

from pathlib import Path

from scripts.memory_hub.jsonio import read_jsonl
from scripts.memory_hub.paths import hub_paths


def enqueue_review_item(root, item: dict) -> dict:
    from scripts.memory_hub.mirror_store import append_review_item

    append_review_item(root, item)
    return item


def list_review_items(root: Path) -> list[dict]:
    return read_jsonl(hub_paths(root)["review_queue"], default=[])
