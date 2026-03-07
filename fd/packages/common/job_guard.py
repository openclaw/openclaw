from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from packages.common.config import settings


@dataclass
class JobGuard:
    job_name: str
    start_ts: float
    processed: int = 0
    errors: int = 0
    reads: int = 0
    writes: int = 0

    def should_stop(self) -> str | None:
        if self.processed >= settings.JOB_BATCH_LIMIT:
            return "batch_limit_reached"
        if (time.time() - self.start_ts) >= settings.JOB_MAX_RUNTIME_SECONDS:
            return "runtime_limit_reached"
        if self.errors >= settings.JOB_MAX_ERRORS_PER_RUN:
            return "error_limit_reached"
        if self.writes >= settings.TRELLO_JOB_MAX_MUTATIONS_PER_RUN:
            return "write_budget_reached"
        if self.reads >= settings.TRELLO_JOB_MAX_READS_PER_RUN:
            return "read_budget_reached"
        return None

    def mark_processed(self, n: int = 1) -> None:
        self.processed += n

    def mark_error(self, n: int = 1) -> None:
        self.errors += n

    def mark_read(self, n: int = 1) -> None:
        self.reads += n

    def mark_write(self, n: int = 1) -> None:
        self.writes += n

    def snapshot(self) -> dict[str, Any]:
        return {
            "job": self.job_name,
            "processed": self.processed,
            "errors": self.errors,
            "reads": self.reads,
            "writes": self.writes,
            "elapsed_seconds": round(time.time() - self.start_ts, 3),
            "limits": {
                "batch": settings.JOB_BATCH_LIMIT,
                "runtime_seconds": settings.JOB_MAX_RUNTIME_SECONDS,
                "errors": settings.JOB_MAX_ERRORS_PER_RUN,
                "reads": settings.TRELLO_JOB_MAX_READS_PER_RUN,
                "writes": settings.TRELLO_JOB_MAX_MUTATIONS_PER_RUN,
            },
        }


def new_guard(job_name: str) -> JobGuard:
    return JobGuard(job_name=job_name, start_ts=time.time())
