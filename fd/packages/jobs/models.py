"""Job data models for the file-based cluster job queue.

Jobs flow through ~/cluster/jobs as JSON files:
  pending/   -> a worker picks it up
  active/    -> currently being processed
  done/      -> completed successfully
  failed/    -> failed (with error details)

Each job file is a self-contained JSON document with all info needed to execute.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any


class JobStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    DONE = "done"
    FAILED = "failed"


class CreativeLane(str, Enum):
    REMOTION_JSON = "remotion_json"
    UGC = "ugc"
    FACELESS = "faceless"
    POV = "pov"
    INFOGRAPHIC = "infographic"


class JobPriority(str, Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


def _generate_job_id(brand: str, lane: str) -> str:
    """Generate a deterministic-prefix job ID: job_{brand}_{lane}_{8hex}."""
    ts = datetime.now(tz=UTC).isoformat()
    raw = f"{brand}:{lane}:{ts}"
    suffix = hashlib.sha256(raw.encode()).hexdigest()[:8]
    return f"job_{brand}_{lane}_{suffix}"


@dataclass
class RenderJob:
    """A single render job to be executed by a cluster worker."""

    job_id: str
    brand: str  # "cutmv" or "fulldigital"
    lane: CreativeLane
    status: JobStatus = JobStatus.PENDING
    priority: JobPriority = JobPriority.NORMAL

    # What to render
    template_id: str = ""
    composition_id: str = ""
    input_props: dict[str, Any] = field(default_factory=dict)

    # Where assets live (resolved by the worker)
    asset_source_path: str = ""

    # Output config
    output_format: str = "mp4"
    output_width: int = 1080
    output_height: int = 1920
    output_fps: int = 30

    # Tracking
    created_at: str = field(default_factory=lambda: datetime.now(tz=UTC).isoformat())
    claimed_by: str = ""  # hostname of worker that claimed it
    claimed_at: str = ""
    completed_at: str = ""
    error: str = ""
    result_path: str = ""  # path in ~/cluster/results/
    correlation_id: str = ""
    attempt: int = 0
    max_attempts: int = 3

    @classmethod
    def create(
        cls,
        *,
        brand: str,
        lane: CreativeLane,
        template_id: str,
        composition_id: str = "",
        input_props: dict[str, Any] | None = None,
        priority: JobPriority = JobPriority.NORMAL,
        correlation_id: str = "",
        **kwargs: Any,
    ) -> RenderJob:
        return cls(
            job_id=_generate_job_id(brand, lane.value),
            brand=brand,
            lane=lane,
            template_id=template_id,
            composition_id=composition_id,
            input_props=input_props or {},
            priority=priority,
            correlation_id=correlation_id,
            **kwargs,
        )

    def to_json(self) -> str:
        d = asdict(self)
        d["lane"] = self.lane.value
        d["status"] = self.status.value
        d["priority"] = self.priority.value
        return json.dumps(d, indent=2)

    @classmethod
    def from_json(cls, raw: str) -> RenderJob:
        d = json.loads(raw)
        d["lane"] = CreativeLane(d["lane"])
        d["status"] = JobStatus(d["status"])
        d["priority"] = JobPriority(d["priority"])
        return cls(**d)
