from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

EventType = Literal["user_confirmed", "task_completed", "session_compacted", "session_ending"]
MemoryType = Literal["user", "feedback", "project", "reference", "daily_log"]
MemoryStatus = Literal["candidate", "active", "superseded", "conflicted", "stale"]
Stability = Literal["ephemeral", "stable"]
RiskLevel = Literal["low", "medium", "high"]
BindingStatus = Literal["active", "superseded", "stale"]
WritebackAction = Literal["auto_write", "enqueue_review", "raise_conflict", "store_only"]


@dataclass(frozen=True)
class SourceRevision:
    mtime: float
    sha256: str

    def to_dict(self) -> dict:
        return asdict(self)
