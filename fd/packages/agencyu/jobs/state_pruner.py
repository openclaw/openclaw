"""State pruner job — trims bounded state tables daily.

Prunes:
- recent_job_stops_json in system_state (caps at 200 entries)
- Old audit log entries beyond retention (optional)
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.agencyu.notion.system_state import SystemState
from packages.common.logging import get_logger

log = get_logger("agencyu.jobs.state_pruner")


def run_state_pruner(conn: sqlite3.Connection) -> dict[str, Any]:
    """Prune bounded state entries.

    Returns dict with pruning results.
    """
    state = SystemState(conn)

    prune_result = state.prune_recent_job_stops()

    log.info("state_pruner_complete", extra=prune_result)

    return {
        "ok": True,
        "job_stops": prune_result,
    }
