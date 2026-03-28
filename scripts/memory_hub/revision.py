from __future__ import annotations

import hashlib
from pathlib import Path

from scripts.memory_hub.types import SourceRevision


def capture_source_revision(path: Path) -> SourceRevision:
    stat = path.stat()
    data = path.read_bytes()
    return SourceRevision(mtime=stat.st_mtime, sha256=hashlib.sha256(data).hexdigest())


def cas_matches(path: Path, expected: SourceRevision) -> bool:
    current = capture_source_revision(path)
    return current.mtime == expected.mtime and current.sha256 == expected.sha256
