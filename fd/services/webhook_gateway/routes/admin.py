from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.cooldown import (
    is_cooldown_active,
    record_trello_failure_and_maybe_trip,
    record_trello_success,
)
from packages.common.db import connect, init_schema
from packages.common.errors import KillSwitchEnabledError, ReadOnlyError
from packages.common.ids import new_id
from packages.common.job_guard import new_guard
from packages.common.job_runs import record_job_run
from packages.domain.checkout import create_checkout_link
from packages.domain.ghl_contact_index import resolve_ghl_contact_id
from packages.domain.offer_intent_v2 import attach_offer_intent_board, get_offer_intent
from packages.domain.reconcile_board_links import reconcile_board_links
from packages.domain.scheduled_jobs import run_scheduled_jobs
from packages.domain.stage_sync_internal_client import SYNC_LISTS
from packages.domain.trello_provisioning import provision_client_board
from packages.domain.work_order_links import get_by_client_card_id, upsert_link
from packages.integrations.trello.client import TrelloClient
from packages.integrations.trello.rate_limit import TrelloRateLimitError
from services.webhook_gateway.ops_security import require_admin_ops_token

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


# ---------------------------------------------------------------------------
# POST /admin/create_checkout_link
# ---------------------------------------------------------------------------


class CheckoutLinkRequest(BaseModel):
    offer_code: str
    ghl_contact_id: str | None = None
    email: str | None = None
    phone: str | None = None
    correlation_id: str | None = None


@router.post("/create_checkout_link")
def admin_create_checkout_link(
    req: CheckoutLinkRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    cid = req.correlation_id or new_id("corr")
    result = create_checkout_link(
        _conn,
        offer_code=req.offer_code,
        ghl_contact_id=req.ghl_contact_id,
        email=req.email,
        phone=req.phone,
        correlation_id=cid,
    )
    return {**result, "correlation_id": cid}


# ---------------------------------------------------------------------------
# POST /admin/provision_client
# ---------------------------------------------------------------------------


class ProvisionClientRequest(BaseModel):
    ghl_contact_id: str
    client_display_name: str
    email: str | None = None
    phone: str | None = None
    correlation_id: str | None = None


@router.post("/provision_client")
def admin_provision_client(
    req: ProvisionClientRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    cid = req.correlation_id or new_id("corr")
    result = provision_client_board(
        _conn,
        ghl_contact_id=req.ghl_contact_id,
        client_display_name=req.client_display_name,
        email=req.email,
        phone=req.phone,
        correlation_id=cid,
    )
    return {**result, "correlation_id": cid}


# ---------------------------------------------------------------------------
# POST /admin/provision_from_offer_intent
# ---------------------------------------------------------------------------


class ProvisionFromOfferIntentRequest(BaseModel):
    offer_intent_id: str
    correlation_id: str | None = None


@router.post("/provision_from_offer_intent")
def admin_provision_from_offer_intent(
    req: ProvisionFromOfferIntentRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    cid = req.correlation_id or new_id("corr")
    row = get_offer_intent(_conn, offer_intent_id=req.offer_intent_id)
    if not row:
        return {"ok": False, "error": "offer_intent_not_found", "correlation_id": cid}

    ghl_contact_id = resolve_ghl_contact_id(
        _conn,
        ghl_contact_id=row.get("ghl_contact_id"),
        email=row.get("email"),
        phone=row.get("phone"),
        trello_board_id=None,
        correlation_id=cid,
    )
    if not ghl_contact_id:
        return {"ok": False, "error": "ghl_contact_not_resolved", "correlation_id": cid}

    client_name = row.get("email") or f"Client {ghl_contact_id}"
    prov = provision_client_board(
        _conn,
        ghl_contact_id=ghl_contact_id,
        client_display_name=client_name,
        email=row.get("email"),
        phone=row.get("phone"),
        correlation_id=cid,
    )

    if prov.get("trello_board_id"):
        attach_offer_intent_board(
            _conn,
            offer_intent_id=req.offer_intent_id,
            trello_board_id=prov["trello_board_id"],
            correlation_id=cid,
        )

    return {**prov, "offer_intent_id": req.offer_intent_id, "correlation_id": cid}


# ---------------------------------------------------------------------------
# POST /admin/seed_capacity
# ---------------------------------------------------------------------------


class AssigneeSeed(BaseModel):
    assignee_id: str
    display_name: str
    roles: list[str]
    weight: int = 1
    enabled: bool = True


class SeedCapacityRequest(BaseModel):
    assignees: list[AssigneeSeed]
    correlation_id: str | None = None


@router.post("/seed_capacity")
def admin_seed_capacity(
    req: SeedCapacityRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")
    if settings.READ_ONLY:
        raise ReadOnlyError("READ_ONLY enabled")

    import json

    cid = req.correlation_id or new_id("corr")
    upserted: list[str] = []

    for a in req.assignees:
        roles_json = json.dumps(a.roles)
        _conn.execute(
            """INSERT INTO team_capacity
               (assignee_id, display_name, roles_json, weight, active_jobs, enabled)
               VALUES (?,?,?,?,0,?)
               ON CONFLICT(assignee_id) DO UPDATE SET
                 display_name=excluded.display_name,
                 roles_json=excluded.roles_json,
                 weight=excluded.weight,
                 enabled=excluded.enabled
            """,
            (a.assignee_id, a.display_name, roles_json, a.weight, int(a.enabled)),
        )
        upserted.append(a.assignee_id)

    _conn.commit()

    write_audit(
        _conn,
        action="admin.seed_capacity",
        target="team_capacity",
        payload={"upserted": upserted},
        correlation_id=cid,
    )
    return {"ok": True, "upserted": upserted, "correlation_id": cid}


# ---------------------------------------------------------------------------
# POST /admin/reconcile_board_links
# ---------------------------------------------------------------------------


class ReconcileBoardLinksRequest(BaseModel):
    limit: int = 200
    correlation_id: str | None = None


@router.post("/reconcile_board_links")
def admin_reconcile_board_links(
    req: ReconcileBoardLinksRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    cid = req.correlation_id or new_id("corr")
    result = reconcile_board_links(
        _conn,
        limit=req.limit,
        correlation_id=cid,
    )
    return {**result, "correlation_id": cid}


# ---------------------------------------------------------------------------
# GET /admin/status
# ---------------------------------------------------------------------------


@router.get("/status")
def admin_status(_: None = Depends(require_admin_ops_token)) -> dict[str, Any]:
    return {
        "ok": True,
        "env": settings.ENV,
        "dry_run": settings.DRY_RUN,
        "safe_mode": settings.SAFE_MODE,
        "kill_switch": settings.KILL_SWITCH,
        "read_only": settings.READ_ONLY,
    }


# ---------------------------------------------------------------------------
# POST /admin/run_scheduled_jobs
# ---------------------------------------------------------------------------


class RunScheduledJobsRequest(BaseModel):
    correlation_id: str | None = None


@router.post("/run_scheduled_jobs")
def admin_run_scheduled_jobs(
    req: RunScheduledJobsRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    cid = req.correlation_id or new_id("corr")
    result = run_scheduled_jobs(
        _conn,
        correlation_id=cid,
    )
    return {**result, "correlation_id": cid}


# ---------------------------------------------------------------------------
# POST /admin/reconcile_work_order_links
# ---------------------------------------------------------------------------


class ReconcileWorkOrderLinksRequest(BaseModel):
    limit: int = 200
    correlation_id: str | None = None


@router.post("/reconcile_work_order_links")
def admin_reconcile_work_order_links(
    req: ReconcileWorkOrderLinksRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Scan work_orders table and backfill any missing work_order_links rows."""
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    cid = req.correlation_id or new_id("corr")
    started_ts = datetime.now(tz=UTC).isoformat()
    guard = new_guard("reconcile_work_order_links")
    rows = _conn.execute(
        """SELECT client_card_id, client_board_id, internal_card_id
           FROM work_orders
           WHERE client_card_id IS NOT NULL AND internal_card_id IS NOT NULL
           ORDER BY ts DESC LIMIT ?""",
        (min(req.limit, settings.JOB_BATCH_LIMIT * 2),),
    ).fetchall()

    created = 0
    skipped = 0
    for row in rows:
        stop_reason = guard.should_stop()
        if stop_reason:
            write_audit(
                _conn,
                action="reconcile_work_order_links.stopped.guard",
                target="work_order_links",
                payload={"reason": stop_reason, **guard.snapshot()},
                correlation_id=cid,
            )
            record_job_run(
                _conn, job_name="reconcile_work_order_links", status="stopped", stop_reason=stop_reason,
                started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
                stats=guard.snapshot(), correlation_id=cid,
            )
            return {"ok": True, "stopped": True, "reason": stop_reason, "stats": guard.snapshot(), "correlation_id": cid}

        client_card_id = row["client_card_id"]
        internal_card_id = row["internal_card_id"]
        client_board_id = row["client_board_id"] or ""

        existing = get_by_client_card_id(_conn, client_card_id)
        if existing:
            skipped += 1
            continue

        upsert_link(
            _conn,
            client_card_id=client_card_id,
            internal_card_id=internal_card_id,
            client_board_id=client_board_id,
            internal_board_id=settings.INTERNAL_FULFILLMENT_TRELLO_BOARD_ID,
        )
        created += 1
        guard.mark_processed()

    write_audit(
        _conn,
        action="admin.reconcile_work_order_links",
        target="work_order_links",
        payload={"created": created, "skipped": skipped, "scanned": len(rows), **guard.snapshot()},
        correlation_id=cid,
    )
    record_job_run(
        _conn, job_name="reconcile_work_order_links", status="success", stop_reason=None,
        started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
        stats=guard.snapshot(), correlation_id=cid,
    )
    return {"ok": True, "created": created, "skipped": skipped, "scanned": len(rows), "stats": guard.snapshot(), "correlation_id": cid}


# ---------------------------------------------------------------------------
# POST /admin/reconcile_stage_sync
# ---------------------------------------------------------------------------


class ReconcileStageSyncRequest(BaseModel):
    limit: int = 200
    correlation_id: str | None = None


@router.post("/reconcile_stage_sync")
def admin_reconcile_stage_sync(
    req: ReconcileStageSyncRequest,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """For each work_order_links pair, fetch both cards, resolve drift.

    If both cards are in synced lanes but differ, the card with the newer
    action_date wins and the other is moved to match.

    SAFE_MODE/DRY_RUN: simulate only.
    """
    if settings.KILL_SWITCH:
        raise KillSwitchEnabledError("KILL_SWITCH enabled")

    cid = req.correlation_id or new_id("corr")
    started_ts = datetime.now(tz=UTC).isoformat()

    if is_cooldown_active(_conn):
        record_job_run(
            _conn, job_name="reconcile_stage_sync", status="skipped", stop_reason="cooldown_active",
            started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
            stats={}, correlation_id=cid,
        )
        return {"ok": True, "skipped": True, "reason": "cooldown_active", "correlation_id": cid}

    mode = "dry_run" if (settings.DRY_RUN or settings.SAFE_MODE) else "live"
    guard = new_guard("reconcile_stage_sync")

    rows = _conn.execute(
        """SELECT client_card_id, client_board_id, internal_card_id, internal_board_id
           FROM work_order_links
           WHERE status='active'
           LIMIT ?""",
        (min(req.limit, settings.JOB_BATCH_LIMIT * 2),),
    ).fetchall()

    tc = TrelloClient() if mode == "live" else None
    repaired = 0
    skipped = 0
    errors: list[dict[str, str]] = []

    for row in rows:
        stop_reason = guard.should_stop()
        if stop_reason:
            write_audit(
                _conn,
                action="reconcile_stage_sync.stopped.guard",
                target="stage_sync",
                payload={"reason": stop_reason, **guard.snapshot()},
                correlation_id=cid,
            )
            record_job_run(
                _conn, job_name="reconcile_stage_sync", status="stopped", stop_reason=stop_reason,
                started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
                stats=guard.snapshot(), correlation_id=cid,
            )
            return {
                "ok": True, "stopped": True, "reason": stop_reason,
                "stats": guard.snapshot(), "correlation_id": cid,
            }

        client_card_id = row["client_card_id"]
        internal_card_id = row["internal_card_id"]

        if mode == "dry_run":
            write_audit(
                _conn,
                action="reconcile_stage_sync.simulated",
                target=client_card_id,
                payload={"internal_card_id": internal_card_id},
                correlation_id=cid,
            )
            skipped += 1
            guard.mark_processed()
            continue

        try:
            assert tc is not None
            guard.mark_read(2)  # two get_card calls
            client_card = tc.get_card(card_id=client_card_id)
            internal_card = tc.get_card(card_id=internal_card_id)

            # Resolve list names from list IDs
            client_board_id = row["client_board_id"]
            internal_board_id = row["internal_board_id"]
            guard.mark_read(2)  # two get_lists calls
            client_lists = {lst["id"]: lst["name"] for lst in tc.get_lists(board_id=client_board_id)}
            internal_lists = {lst["id"]: lst["name"] for lst in tc.get_lists(board_id=internal_board_id)}

            client_list_name = client_lists.get(client_card.get("idList", ""), "")
            internal_list_name = internal_lists.get(internal_card.get("idList", ""), "")

            # Both must be in synced lanes to reconcile
            if client_list_name not in SYNC_LISTS or internal_list_name not in SYNC_LISTS:
                skipped += 1
                guard.mark_processed()
                continue

            if client_list_name == internal_list_name:
                skipped += 1
                guard.mark_processed()
                continue

            # Determine winner by dateLastActivity (Trello provides this)
            client_date = client_card.get("dateLastActivity", "")
            internal_date = internal_card.get("dateLastActivity", "")

            if internal_date >= client_date:
                # Internal is newer — move client to match
                winner_list = internal_list_name
                target_card_id = client_card_id
                target_board_id = client_board_id
            else:
                # Client is newer — move internal to match
                winner_list = client_list_name
                target_card_id = internal_card_id
                target_board_id = internal_board_id

            guard.mark_read()  # get_lists for target board
            target_lists = {lst["name"]: lst["id"] for lst in tc.get_lists(board_id=target_board_id)}
            target_list_id = target_lists.get(winner_list)
            if target_list_id:
                guard.mark_write()
                tc.move_card(card_id=target_card_id, list_id=target_list_id)
                record_trello_success(_conn)
                repaired += 1
                write_audit(
                    _conn,
                    action="reconcile_stage_sync.repaired",
                    target=target_card_id,
                    payload={
                        "moved_to": winner_list,
                        "client_was": client_list_name,
                        "internal_was": internal_list_name,
                    },
                    correlation_id=cid,
                )
            else:
                skipped += 1

            guard.mark_processed()

        except TrelloRateLimitError:
            guard.mark_error()
            record_trello_failure_and_maybe_trip(
                _conn,
                is_rate_limit=True,
                max_failures_before_trip=settings.COOLDOWN_FAILS_BEFORE_TRIP,
                cooldown_seconds=settings.COOLDOWN_BASE_SECONDS,
                cooldown_max_seconds=settings.COOLDOWN_MAX_SECONDS,
            )
            errors.append({"card": client_card_id, "error": "rate_limited"})
            break  # stop processing during rate limit

        except Exception as exc:
            guard.mark_error()
            record_trello_failure_and_maybe_trip(
                _conn,
                is_rate_limit=False,
                max_failures_before_trip=settings.COOLDOWN_FAILS_BEFORE_TRIP,
                cooldown_seconds=settings.COOLDOWN_BASE_SECONDS,
                cooldown_max_seconds=settings.COOLDOWN_MAX_SECONDS,
            )
            errors.append({"card": client_card_id, "error": str(exc)})

    write_audit(
        _conn,
        action="admin.reconcile_stage_sync",
        target="stage_sync",
        payload={"mode": mode, "repaired": repaired, "skipped": skipped, "errors": len(errors), **guard.snapshot()},
        correlation_id=cid,
    )
    status = "success" if not errors else "failed"
    record_job_run(
        _conn, job_name="reconcile_stage_sync", status=status, stop_reason=None,
        started_ts=started_ts, finished_ts=datetime.now(tz=UTC).isoformat(),
        stats=guard.snapshot(), correlation_id=cid,
    )
    return {
        "ok": True,
        "mode": mode,
        "repaired": repaired,
        "skipped": skipped,
        "errors": errors[:10],
        "stats": guard.snapshot(),
        "correlation_id": cid,
    }
