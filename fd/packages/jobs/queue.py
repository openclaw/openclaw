"""File-based job queue using ~/cluster/jobs as the shared medium.

Architecture:
  ~/cluster/jobs/
    pending/    job lands here when submitted
    active/     worker moves it here on claim (atomic rename via SMB)
    done/       worker moves it here on success
    failed/     worker moves it here on failure

Atomic claim: os.rename() across SMB is atomic on macOS/APFS.
If two workers race, only one rename succeeds; the loser gets FileNotFoundError.

This is intentionally simple. No Redis, no RabbitMQ, no external deps.
The shared SMB mount IS the message broker.
"""
from __future__ import annotations

import json
import os
import socket
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

from packages.jobs.models import JobPriority, JobStatus, RenderJob

_HOSTNAME = socket.gethostname()


def _jobs_dir() -> Path:
    """Resolve the cluster jobs directory."""
    base = os.environ.get("OPENCLAW_SHARED_JOBS", os.path.expanduser("~/cluster/jobs"))
    return Path(base)


def _ensure_dirs(base: Path) -> None:
    """Create queue subdirectories if they don't exist."""
    for sub in ("pending", "active", "done", "failed"):
        (base / sub).mkdir(parents=True, exist_ok=True)


def submit(job: RenderJob) -> Path:
    """Submit a job to the pending queue. Returns the file path."""
    base = _jobs_dir()
    _ensure_dirs(base)

    job.status = JobStatus.PENDING
    dest = base / "pending" / f"{job.job_id}.json"
    dest.write_text(job.to_json(), encoding="utf-8")
    return dest


def list_pending(*, lane: str | None = None) -> list[RenderJob]:
    """List all pending jobs, optionally filtered by lane. Sorted by priority then age."""
    base = _jobs_dir()
    pending_dir = base / "pending"
    if not pending_dir.exists():
        return []

    jobs: list[RenderJob] = []
    for f in pending_dir.glob("*.json"):
        try:
            job = RenderJob.from_json(f.read_text(encoding="utf-8"))
            if lane and job.lane.value != lane:
                continue
            jobs.append(job)
        except Exception:
            continue

    # Sort: urgent > high > normal > low, then oldest first
    priority_order = {
        JobPriority.URGENT: 0,
        JobPriority.HIGH: 1,
        JobPriority.NORMAL: 2,
        JobPriority.LOW: 3,
    }
    jobs.sort(key=lambda j: (priority_order.get(j.priority, 9), j.created_at))
    return jobs


def claim(job_id: str) -> Optional[RenderJob]:
    """Atomically claim a pending job. Returns the job if claimed, None if already taken.

    Uses os.rename for atomic move across SMB. If another worker already
    claimed it, we get FileNotFoundError and return None.
    """
    base = _jobs_dir()
    src = base / "pending" / f"{job_id}.json"
    dst = base / "active" / f"{job_id}.json"

    try:
        os.rename(str(src), str(dst))
    except FileNotFoundError:
        return None  # Already claimed by another worker

    job = RenderJob.from_json(dst.read_text(encoding="utf-8"))
    job.status = JobStatus.ACTIVE
    job.claimed_by = _HOSTNAME
    job.claimed_at = datetime.now(tz=UTC).isoformat()
    job.attempt += 1
    dst.write_text(job.to_json(), encoding="utf-8")
    return job


def complete(job: RenderJob, *, result_path: str = "") -> Path:
    """Mark a job as done and move to the done directory."""
    base = _jobs_dir()
    src = base / "active" / f"{job.job_id}.json"
    dst = base / "done" / f"{job.job_id}.json"

    job.status = JobStatus.DONE
    job.completed_at = datetime.now(tz=UTC).isoformat()
    job.result_path = result_path

    # Write updated state then move
    src.write_text(job.to_json(), encoding="utf-8")
    os.rename(str(src), str(dst))
    return dst


def fail(job: RenderJob, *, error: str = "") -> Path:
    """Mark a job as failed. If retries remain, re-queue to pending."""
    base = _jobs_dir()
    src = base / "active" / f"{job.job_id}.json"

    job.error = error
    job.completed_at = datetime.now(tz=UTC).isoformat()

    if job.attempt < job.max_attempts:
        # Re-queue for retry
        job.status = JobStatus.PENDING
        job.claimed_by = ""
        job.claimed_at = ""
        job.completed_at = ""
        dst = base / "pending" / f"{job.job_id}.json"
    else:
        # Exhausted retries
        job.status = JobStatus.FAILED
        dst = base / "failed" / f"{job.job_id}.json"

    src.write_text(job.to_json(), encoding="utf-8")
    os.rename(str(src), str(dst))
    return dst


def stats() -> dict[str, int]:
    """Return counts of jobs in each state."""
    base = _jobs_dir()
    result = {}
    for sub in ("pending", "active", "done", "failed"):
        d = base / sub
        if d.exists():
            result[sub] = len(list(d.glob("*.json")))
        else:
            result[sub] = 0
    return result
