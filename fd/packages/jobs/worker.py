"""Cluster worker: polls ~/cluster/jobs/pending and executes render jobs.

Run on each compute node:
  python -m packages.jobs.worker

The worker:
  1. Scans pending/ for jobs matching its capabilities
  2. Atomically claims a job (rename pending/ -> active/)
  3. Executes the render (lane-specific handler)
  4. Moves result to ~/cluster/results/ and marks job done
  5. On failure, retries up to max_attempts then moves to failed/

Designed to run in a tmux session alongside the app server.
"""
from __future__ import annotations

import os
import socket
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from packages.jobs.models import CreativeLane, RenderJob
from packages.jobs.queue import claim, complete, fail, list_pending
from packages.jobs.router import should_worker_claim

_HOSTNAME = socket.gethostname()
_POLL_INTERVAL = int(os.environ.get("OPENCLAW_WORKER_POLL_SECONDS", "5"))
_RESULTS_DIR = os.environ.get("OPENCLAW_SHARED_RESULTS", os.path.expanduser("~/cluster/results"))


def _resolve_asset_path(job: RenderJob) -> str:
    """Resolve the asset source path for a job based on brand."""
    if job.asset_source_path:
        return job.asset_source_path

    brand_paths = {
        "cutmv": os.environ.get("CUTMV_AD_LIBRARY", os.path.expanduser("~/cutmv-ad-library")),
        "fulldigital": os.environ.get("FULLDIGITAL_AD_LIBRARY", os.path.expanduser("~/fulldigital-ad-library")),
    }
    return brand_paths.get(job.brand, "")


def _execute_remotion_json(job: RenderJob) -> dict[str, Any]:
    """Execute a Remotion JSON render job.

    Calls `npx remotion render` with the job's composition and props.
    Output goes to ~/cluster/results/{job_id}.{format}
    """
    asset_path = _resolve_asset_path(job)
    output_file = f"{job.job_id}.{job.output_format}"
    output_path = str(Path(_RESULTS_DIR) / output_file)

    Path(_RESULTS_DIR).mkdir(parents=True, exist_ok=True)

    # Build remotion render command
    cmd = [
        "npx", "remotion", "render",
        job.composition_id or "Main",
        output_path,
        "--props", str(job.input_props),
    ]

    if job.output_width:
        cmd.extend(["--width", str(job.output_width)])
    if job.output_height:
        cmd.extend(["--height", str(job.output_height)])

    # Execute in the asset directory if it exists
    cwd = asset_path if asset_path and Path(asset_path).exists() else None

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,  # 10 minute timeout per render
        cwd=cwd,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Remotion render failed: {result.stderr[:500]}")

    return {"output_path": output_path, "stdout": result.stdout[:200]}


def _execute_stub(job: RenderJob) -> dict[str, Any]:
    """Stub handler for lanes not yet implemented."""
    output_file = f"{job.job_id}.stub.json"
    output_path = str(Path(_RESULTS_DIR) / output_file)

    Path(_RESULTS_DIR).mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(
        f'{{"job_id": "{job.job_id}", "lane": "{job.lane.value}", "status": "stub", '
        f'"note": "Lane handler not yet implemented"}}',
        encoding="utf-8",
    )
    return {"output_path": output_path, "stub": True}


# Lane -> handler mapping
_LANE_HANDLERS = {
    CreativeLane.REMOTION_JSON: _execute_remotion_json,
    CreativeLane.UGC: _execute_stub,
    CreativeLane.FACELESS: _execute_stub,
    CreativeLane.POV: _execute_stub,
    CreativeLane.INFOGRAPHIC: _execute_stub,
}


def _process_job(job: RenderJob) -> None:
    """Execute a single job and handle success/failure."""
    handler = _LANE_HANDLERS.get(job.lane, _execute_stub)

    try:
        result = handler(job)
        result_path = result.get("output_path", "")
        complete(job, result_path=result_path)
        print(f"[worker] DONE {job.job_id} -> {result_path}")
    except Exception as exc:
        error_msg = str(exc)[:500]
        fail(job, error=error_msg)
        print(f"[worker] FAIL {job.job_id}: {error_msg}")


def run_once() -> int:
    """Poll once for pending jobs. Returns number of jobs processed."""
    pending = list_pending()
    processed = 0

    for job in pending:
        if not should_worker_claim(job, _HOSTNAME):
            continue

        claimed = claim(job.job_id)
        if not claimed:
            continue  # Another worker got it

        print(f"[worker] CLAIMED {claimed.job_id} (lane={claimed.lane.value}, brand={claimed.brand})")
        _process_job(claimed)
        processed += 1

    return processed


def run_loop() -> None:
    """Run the worker loop indefinitely."""
    print(f"[worker] Starting on {_HOSTNAME}")
    print(f"[worker] Poll interval: {_POLL_INTERVAL}s")
    print(f"[worker] Results dir: {_RESULTS_DIR}")

    while True:
        try:
            processed = run_once()
            if processed > 0:
                print(f"[worker] Processed {processed} job(s)")
        except KeyboardInterrupt:
            print("\n[worker] Shutting down.")
            break
        except Exception as exc:
            print(f"[worker] Error in poll loop: {exc}")

        time.sleep(_POLL_INTERVAL)
