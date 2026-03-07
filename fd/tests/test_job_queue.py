"""Tests for the file-based job queue and routing system."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from packages.jobs.models import CreativeLane, JobPriority, JobStatus, RenderJob
from packages.jobs.queue import claim, complete, fail, list_pending, stats, submit
from packages.jobs.router import (
    DEFAULT_ROUTING_TABLE,
    get_preferred_node,
    should_worker_claim,
)


@pytest.fixture()
def jobs_dir(tmp_path, monkeypatch):
    """Set up a temp directory as the jobs queue."""
    jobs = tmp_path / "jobs"
    monkeypatch.setenv("OPENCLAW_SHARED_JOBS", str(jobs))
    return jobs


# ── Model Tests ──


def test_render_job_create():
    job = RenderJob.create(
        brand="cutmv",
        lane=CreativeLane.REMOTION_JSON,
        template_id="hero_ad_01",
        composition_id="HeroAd",
        input_props={"headline": "Test"},
    )
    assert job.job_id.startswith("job_cutmv_remotion_json_")
    assert job.brand == "cutmv"
    assert job.lane == CreativeLane.REMOTION_JSON
    assert job.status == JobStatus.PENDING
    assert job.input_props == {"headline": "Test"}


def test_render_job_roundtrip():
    job = RenderJob.create(
        brand="fulldigital",
        lane=CreativeLane.UGC,
        template_id="ugc_testimonial",
        priority=JobPriority.HIGH,
    )
    raw = job.to_json()
    restored = RenderJob.from_json(raw)
    assert restored.job_id == job.job_id
    assert restored.lane == CreativeLane.UGC
    assert restored.priority == JobPriority.HIGH
    assert restored.brand == "fulldigital"


# ── Queue Tests ──


def test_submit_creates_file(jobs_dir):
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    path = submit(job)
    assert path.exists()
    assert "pending" in str(path)
    data = json.loads(path.read_text())
    assert data["status"] == "pending"


def test_claim_moves_to_active(jobs_dir):
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    submit(job)
    claimed = claim(job.job_id)
    assert claimed is not None
    assert claimed.status == JobStatus.ACTIVE
    assert claimed.claimed_by != ""
    assert claimed.attempt == 1
    # Pending file should be gone
    assert not (jobs_dir / "pending" / f"{job.job_id}.json").exists()
    assert (jobs_dir / "active" / f"{job.job_id}.json").exists()


def test_double_claim_returns_none(jobs_dir):
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    submit(job)
    first = claim(job.job_id)
    second = claim(job.job_id)
    assert first is not None
    assert second is None


def test_complete_moves_to_done(jobs_dir):
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.FACELESS, template_id="t1"
    )
    submit(job)
    claimed = claim(job.job_id)
    done_path = complete(claimed, result_path="/cluster/results/out.mp4")
    assert done_path.exists()
    data = json.loads(done_path.read_text())
    assert data["status"] == "done"
    assert data["result_path"] == "/cluster/results/out.mp4"


def test_fail_requeues_if_retries_remain(jobs_dir):
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    job.max_attempts = 3
    submit(job)
    claimed = claim(job.job_id)
    fail_path = fail(claimed, error="render crashed")
    # Should be back in pending (attempt 1 < max 3)
    assert "pending" in str(fail_path)
    data = json.loads(fail_path.read_text())
    assert data["status"] == "pending"
    assert data["attempt"] == 1


def test_fail_moves_to_failed_after_max_attempts(jobs_dir):
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    job.max_attempts = 1
    submit(job)
    claimed = claim(job.job_id)
    fail_path = fail(claimed, error="render crashed")
    assert "failed" in str(fail_path)
    data = json.loads(fail_path.read_text())
    assert data["status"] == "failed"
    assert data["error"] == "render crashed"


def test_list_pending_sorted_by_priority(jobs_dir):
    low = RenderJob.create(
        brand="cutmv", lane=CreativeLane.FACELESS, template_id="t1",
        priority=JobPriority.LOW,
    )
    urgent = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t2",
        priority=JobPriority.URGENT,
    )
    normal = RenderJob.create(
        brand="fulldigital", lane=CreativeLane.UGC, template_id="t3",
        priority=JobPriority.NORMAL,
    )
    submit(low)
    submit(urgent)
    submit(normal)
    pending = list_pending()
    assert len(pending) == 3
    assert pending[0].priority == JobPriority.URGENT
    assert pending[2].priority == JobPriority.LOW


def test_stats(jobs_dir):
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    submit(job)
    s = stats()
    assert s["pending"] == 1
    assert s["active"] == 0
    assert s["done"] == 0
    assert s["failed"] == 0


# ── Router Tests ──


def test_remotion_prefers_node_with_assets():
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    preferred = get_preferred_node(job)
    assert preferred == "m4"  # m4 has_local_assets=True


def test_ugc_prefers_compute_node():
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.UGC, template_id="t1"
    )
    preferred = get_preferred_node(job)
    assert preferred == "i7"  # i7 is compute-only


def test_should_claim_preferred_node():
    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    # m4 is preferred -> m4 should claim
    assert should_worker_claim(job, "m4") is True
    # i7 is not preferred -> should not claim (unless stale)
    assert should_worker_claim(job, "i7") is False


def test_should_claim_stale_job():
    """Any worker can claim a job that's been pending too long."""
    from datetime import timedelta

    job = RenderJob.create(
        brand="cutmv", lane=CreativeLane.REMOTION_JSON, template_id="t1"
    )
    # Backdate the created_at to make it stale
    from datetime import UTC, datetime
    job.created_at = (datetime.now(tz=UTC) - timedelta(seconds=600)).isoformat()
    # Even non-preferred node should claim stale jobs
    assert should_worker_claim(job, "i7", stale_seconds=300) is True
