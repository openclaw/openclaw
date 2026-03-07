"""Execute pending scheduled actions (release-date publishing, deferred moves)."""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.cooldown import (
    is_cooldown_active,
    record_trello_failure_and_maybe_trip,
    record_trello_success,
)
from packages.common.job_guard import new_guard
from packages.common.job_runs import record_job_run
from packages.common.logging import get_logger, log_info
from packages.domain.card_state import get_pending_actions, mark_action_done, mark_action_failed
from packages.integrations.trello.client import TrelloClient
from packages.integrations.trello.rate_limit import TrelloRateLimitError

logger = get_logger("scheduled_jobs")


def _find_list_id(tc: TrelloClient, board_id: str, target_names: list[str]) -> str | None:
    """Find the first matching list on a board by name."""
    lists = tc.get_lists(board_id=board_id)
    name_set = {n.strip().lower() for n in target_names}
    for lst in lists:
        if (lst.get("name") or "").strip().lower() in name_set:
            return str(lst["id"])
    return None


def run_scheduled_jobs(
    conn: sqlite3.Connection,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Execute all pending scheduled actions whose run_at_iso <= now.

    SAFE_MODE / DRY_RUN: reports would_run without mutating Trello.
    """
    started_ts = datetime.now(tz=UTC).isoformat()

    # Circuit breaker: skip if cooldown active
    if is_cooldown_active(conn):
        write_audit(
            conn,
            action="scheduled_jobs.skipped.cooldown_active",
            target="scheduled_jobs",
            payload={},
            correlation_id=correlation_id,
        )
        record_job_run(
            conn, job_name="scheduled_jobs", status="skipped", stop_reason="cooldown_active",
            started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
            stats={}, correlation_id=correlation_id,
        )
        return {"ok": True, "skipped": True, "reason": "cooldown_active"}

    now_iso = datetime.now(tz=UTC).isoformat()
    pending = get_pending_actions(conn, before_iso=now_iso)

    if not pending:
        return {"ok": True, "executed": 0, "pending": 0}

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    guard = new_guard("scheduled_jobs")
    results: list[dict[str, Any]] = []

    for act in pending:
        stop_reason = guard.should_stop()
        if stop_reason:
            write_audit(
                conn,
                action="scheduled_jobs.stopped.guard",
                target="scheduled_jobs",
                payload={"reason": stop_reason, **guard.snapshot()},
                correlation_id=correlation_id,
            )
            record_job_run(
                conn, job_name="scheduled_jobs", status="stopped", stop_reason=stop_reason,
                started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
                stats=guard.snapshot(), correlation_id=correlation_id,
            )
            return {"ok": True, "stopped": True, "reason": stop_reason, "stats": guard.snapshot(), "results": results}

        action_id = act["id"]
        action_type = act["action_type"]
        try:
            payload = json.loads(act["payload_json"])
        except Exception:
            mark_action_failed(conn, action_id)
            guard.mark_error()
            results.append({"id": action_id, "status": "failed", "reason": "bad_payload"})
            continue

        log_info(logger, "processing scheduled action", extra={
            "id": action_id, "type": action_type, "mode": mode,
        })

        if mode == "dry_run":
            write_audit(
                conn,
                action=f"scheduled_job.{action_type}.would_run",
                target=str(action_id),
                payload=payload,
                correlation_id=correlation_id,
            )
            results.append({"id": action_id, "status": "would_run", "type": action_type})
            guard.mark_processed()
            continue

        if action_type == "MOVE_CARD":
            # Gate release-date auto-publish behind feature flag
            reason = payload.get("reason", "")
            if reason == "release_date_publish" and not settings.AUTO_PUBLISH_ON_RELEASE_DATE:
                results.append({"id": action_id, "status": "skipped", "reason": "feature_disabled"})
                continue

            card_id = payload.get("card_id", "")
            board_id = payload.get("board_id", "")
            target_names = payload.get("target_list_names", [])

            if not card_id or not board_id or not target_names:
                mark_action_failed(conn, action_id)
                guard.mark_error()
                results.append({"id": action_id, "status": "failed", "reason": "missing_fields"})
                continue

            try:
                tc = TrelloClient()
                guard.mark_read()  # get_lists inside _find_list_id
                list_id = _find_list_id(tc, board_id, target_names)
                if not list_id:
                    mark_action_failed(conn, action_id)
                    guard.mark_error()
                    results.append({"id": action_id, "status": "failed", "reason": "list_not_found"})
                    continue

                guard.mark_write()
                tc.move_card(card_id=card_id, list_id=list_id)
                mark_action_done(conn, action_id)
                record_trello_success(conn)

                write_audit(
                    conn,
                    action="scheduled_job.MOVE_CARD.executed",
                    target=card_id,
                    payload={"list_id": list_id, "board_id": board_id},
                    correlation_id=correlation_id,
                )
                results.append({"id": action_id, "status": "done", "type": action_type})
                guard.mark_processed()
            except TrelloRateLimitError:
                guard.mark_error()
                trip = record_trello_failure_and_maybe_trip(
                    conn,
                    is_rate_limit=True,
                    max_failures_before_trip=settings.COOLDOWN_FAILS_BEFORE_TRIP,
                    cooldown_seconds=settings.COOLDOWN_BASE_SECONDS,
                    cooldown_max_seconds=settings.COOLDOWN_MAX_SECONDS,
                )
                results.append({"id": action_id, "status": "deferred", "reason": "rate_limited", "trip": trip})
                record_job_run(
                    conn, job_name="scheduled_jobs", status="failed", stop_reason="rate_limited",
                    started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
                    stats=guard.snapshot(), correlation_id=correlation_id,
                )
                return {"ok": False, "mode": mode, "reason": "rate_limited", "stats": guard.snapshot(), "results": results}
            except Exception:
                guard.mark_error()
                record_trello_failure_and_maybe_trip(
                    conn,
                    is_rate_limit=False,
                    max_failures_before_trip=settings.COOLDOWN_FAILS_BEFORE_TRIP,
                    cooldown_seconds=settings.COOLDOWN_BASE_SECONDS,
                    cooldown_max_seconds=settings.COOLDOWN_MAX_SECONDS,
                )
                mark_action_failed(conn, action_id)
                results.append({"id": action_id, "status": "failed", "reason": "trello_error"})
        else:
            mark_action_failed(conn, action_id)
            guard.mark_error()
            results.append({"id": action_id, "status": "failed", "reason": f"unknown_type:{action_type}"})

    record_job_run(
        conn, job_name="scheduled_jobs", status="success", stop_reason=None,
        started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
        stats=guard.snapshot(), correlation_id=correlation_id,
    )
    return {"ok": True, "mode": mode, "stats": guard.snapshot(), "pending": len(pending), "results": results}
