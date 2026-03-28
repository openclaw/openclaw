from __future__ import annotations

from pathlib import Path

from scripts.memory_hub.revision import cas_matches
from scripts.memory_hub.types import SourceRevision


def write_memory_entry(
    root: Path,
    memory_file: Path,
    index_file: Path,
    title: str,
    body: str,
    expected_revision: SourceRevision,
) -> None:
    if not cas_matches(memory_file, expected_revision):
        raise RuntimeError("source revision changed")
    memory_file.parent.mkdir(parents=True, exist_ok=True)
    memory_file.write_text(body + "\n", encoding="utf-8")
    line = f"- [{title}]({memory_file.name})\n"
    old = index_file.read_text(encoding="utf-8") if index_file.exists() else ""
    if line not in old:
        index_file.write_text(old + line, encoding="utf-8")
