"""Feature-flagged Media Intelligence staging handoff stub."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .jsonl_writer import write_jsonl
from .models import GmailMediaItem


@dataclass(frozen=True)
class StagingResult:
    enabled: bool
    written_count: int
    output_path: str | None


def stage_items(
    items: Iterable[GmailMediaItem],
    *,
    enabled: bool,
    staging_dir: Path,
    run_id: str,
) -> StagingResult:
    if not enabled:
        return StagingResult(enabled=False, written_count=0, output_path=None)
    output_path = staging_dir / f"{run_id}.jsonl"
    written = write_jsonl(output_path, items)
    return StagingResult(enabled=True, written_count=written, output_path=str(output_path))
