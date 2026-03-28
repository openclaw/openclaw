from __future__ import annotations

from pathlib import Path

from scripts.memory_hub.types import SourceRevision


class HostAdapter:
    def write_memory_entry(
        self,
        root: Path,
        memory_file: Path,
        index_file: Path,
        title: str,
        body: str,
        expected_revision: SourceRevision,
    ) -> None:
        raise NotImplementedError
