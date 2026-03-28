from __future__ import annotations

from pathlib import Path


def hub_root(base: Path) -> Path:
    return base.resolve()


def hub_paths(base: Path) -> dict[str, Path]:
    root = hub_root(base)
    return {
        "root": root,
        "db": root / "hub.sqlite3",
        "events": root / "events" / "events.jsonl",
        "candidates": root / "candidates",
        "active": root / "memories" / "active",
        "superseded": root / "memories" / "superseded",
        "review_queue": root / "review-queue" / "items.jsonl",
        "audit": root / "audit" / "audit.jsonl",
        "backups": root / "audit" / "backups",
    }
