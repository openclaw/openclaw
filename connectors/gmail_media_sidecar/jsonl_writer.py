"""Deterministic JSONL writers for sidecar dry runs and staging."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Protocol


class JsonSerializable(Protocol):
    def to_json(self) -> str: ...


def write_jsonl(path: Path, records: Iterable[JsonSerializable]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(record.to_json())
            handle.write("\n")
            count += 1
    return count
