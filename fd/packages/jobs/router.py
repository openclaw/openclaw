"""Job routing: decides which node should handle a given job.

Routing strategy:
  - M4 (storage_compute): preferred for Remotion JSON renders (has local assets)
  - i7 (compute_worker): preferred for CPU-heavy UGC/faceless renders
  - Any node can handle any job type as fallback

The router doesn't enforce assignment — it sets a `preferred_node` hint.
Workers check the hint and skip jobs not intended for them (unless the job
has been pending longer than STALE_CLAIM_SECONDS, in which case any worker
can pick it up).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from packages.jobs.models import CreativeLane, RenderJob


@dataclass
class NodeCapability:
    """What a cluster node can do."""
    hostname: str
    ssh_alias: str
    lanes: list[CreativeLane]
    has_local_assets: bool = False
    max_concurrent: int = 2


# Default routing table — matches config/runtime.yaml node definitions.
# Override via OPENCLAW_ROUTING_TABLE env var or runtime config.
DEFAULT_ROUTING_TABLE: dict[str, NodeCapability] = {
    "m4": NodeCapability(
        hostname="m4",
        ssh_alias="claw-m4",
        lanes=[
            CreativeLane.REMOTION_JSON,
            CreativeLane.FACELESS,
            CreativeLane.INFOGRAPHIC,
        ],
        has_local_assets=True,
        max_concurrent=2,
    ),
    "i7": NodeCapability(
        hostname="i7",
        ssh_alias="claw-i7",
        lanes=[
            CreativeLane.UGC,
            CreativeLane.FACELESS,
            CreativeLane.POV,
            CreativeLane.REMOTION_JSON,
        ],
        has_local_assets=False,
        max_concurrent=3,
    ),
}


def get_preferred_node(
    job: RenderJob,
    routing_table: dict[str, NodeCapability] | None = None,
) -> Optional[str]:
    """Return the preferred node hostname for a job, or None if any node can handle it."""
    table = routing_table or DEFAULT_ROUTING_TABLE

    # Remotion JSON with assets -> prefer node with local assets
    if job.lane == CreativeLane.REMOTION_JSON:
        for node_id, cap in table.items():
            if cap.has_local_assets and CreativeLane.REMOTION_JSON in cap.lanes:
                return cap.hostname
        # Fallback: any node that supports remotion_json
        for node_id, cap in table.items():
            if CreativeLane.REMOTION_JSON in cap.lanes:
                return cap.hostname

    # UGC -> prefer compute-heavy node (i7)
    if job.lane == CreativeLane.UGC:
        for node_id, cap in table.items():
            if CreativeLane.UGC in cap.lanes and not cap.has_local_assets:
                return cap.hostname

    # General: find first node that supports this lane
    for node_id, cap in table.items():
        if job.lane in cap.lanes:
            return cap.hostname

    return None


def should_worker_claim(
    job: RenderJob,
    my_hostname: str,
    routing_table: dict[str, NodeCapability] | None = None,
    stale_seconds: int = 300,
) -> bool:
    """Decide if the current worker should try to claim this job.

    Rules:
    1. If job has no preferred node -> any worker can claim
    2. If job's preferred node matches my_hostname -> claim it
    3. If job has been pending longer than stale_seconds -> any worker can claim
    4. Otherwise -> skip (let the preferred node handle it)
    """
    from datetime import UTC, datetime

    preferred = get_preferred_node(job, routing_table)

    # No preference -> anyone can claim
    if not preferred:
        return True

    # I'm the preferred node
    if preferred == my_hostname:
        return True

    # Check if job is stale (pending too long)
    try:
        created = datetime.fromisoformat(job.created_at)
        age = (datetime.now(tz=UTC) - created).total_seconds()
        if age > stale_seconds:
            return True
    except (ValueError, TypeError):
        pass

    return False
