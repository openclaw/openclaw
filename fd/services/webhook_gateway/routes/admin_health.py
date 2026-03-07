from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query

from packages.agencyu.notion.manifest_validator import NotionManifestValidator
from packages.agencyu.notion.widgets.compliance_verifier import CommandCenterComplianceVerifier
from packages.agencyu.sync.capacity import get_capacity_overview
from packages.agencyu.sync.replay_buffer import get_buffer_stats
from packages.common.config import settings
from packages.common.cooldown import get_cooldown
from packages.common.db import connect, init_schema
from packages.common.job_runs import get_last_success_ts, get_recent_job_runs
from packages.domain.attribution import get_attribution_backlog_count
from packages.domain.momentum import get_pending_momentum_count
from packages.domain.nurture import get_pending_nurture_count
from services.webhook_gateway.ops_security import require_admin_ops_token

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)

RECONCILE_JOBS = [
    "reconcile_board_links",
    "reconcile_stage_sync",
    "reconcile_work_order_links",
    "scheduled_jobs",
    "nurture_tick",
    "momentum_tick",
]

RECONCILE_STALE_CHECK_JOBS = [
    "reconcile_board_links",
    "reconcile_stage_sync",
    "reconcile_work_order_links",
]


def _safe_count(fn: Any) -> int | None:
    try:
        return fn(_conn)
    except Exception:
        return None


def _queue_depth() -> int | None:
    try:
        row = _conn.execute(
            "SELECT COUNT(*) FROM scheduled_actions WHERE status='pending'"
        ).fetchone()
        return int(row[0]) if row else 0
    except Exception:
        return None


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        clean = s.replace("Z", "+00:00") if s.endswith("Z") else s
        return datetime.fromisoformat(clean)
    except Exception:
        return None


@router.get("/health")
def admin_system_health(
    _: None = Depends(require_admin_ops_token),
    self_heal: bool = Query(False, description="If true, attempt to self-heal missing views (respects write_lock + cooldown)"),
) -> dict[str, Any]:
    cooldown = get_cooldown(_conn)
    recent = get_recent_job_runs(_conn, limit=20)
    last_success = {name: get_last_success_ts(_conn, job_name=name) for name in RECONCILE_JOBS}
    depth = _queue_depth()

    warnings: list[str] = []

    # Warning: cooldown active
    if cooldown.get("active"):
        until = cooldown.get("system_backoff_until") or ""
        warnings.append(f"cooldown_active_until:{until}" if until else "cooldown_active")

    # Warning: queue depth too high
    if depth is not None and depth > settings.HEALTH_WARN_QUEUE_DEPTH_THRESHOLD:
        warnings.append(f"queue_depth_high:{depth}")

    # Warning: reconcile stale (no success in > N hours)
    stale_hours = settings.HEALTH_WARN_RECONCILE_STALE_HOURS
    cutoff = datetime.now(tz=UTC) - timedelta(hours=stale_hours)
    stale: list[str] = []
    for name in RECONCILE_STALE_CHECK_JOBS:
        ts = _parse_iso(last_success.get(name))
        if ts is None or ts < cutoff:
            stale.append(name)
    if stale:
        warnings.append(f"reconcile_stale_over_{stale_hours}h:" + ",".join(stale))

    # AgencyU signals
    nurture_pending = _safe_count(get_pending_nurture_count)
    momentum_pending = _safe_count(get_pending_momentum_count)
    attribution_backlog = _safe_count(get_attribution_backlog_count)

    # Notion compliance status (lightweight — no API calls)
    notion_compliance: dict[str, Any] = {}
    try:
        validator = NotionManifestValidator(_conn)
        compliance = validator.validate()
        notion_compliance = {
            "compliant": compliance.compliant,
            "drift_issue_count": len(compliance.issues),
            "healable": compliance.healable_count,
            "manual": compliance.manual_count,
            "manifest_version": compliance.manifest_version,
        }
    except Exception:
        notion_compliance = {"error": "validator_unavailable"}

    # Last heal timestamp
    last_heal_ts: str | None = None
    try:
        row = _conn.execute(
            "SELECT created_at FROM system_snapshots WHERE key='last_drift_heal' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if row:
            last_heal_ts = row["created_at"]
    except Exception:
        pass

    if notion_compliance.get("drift_issue_count", 0) > 0:
        warnings.append(f"notion_drift_issues:{notion_compliance.get('drift_issue_count', 0)}")

    # Command Center compliance
    cc_compliance: dict[str, Any] = {}
    try:
        cc_verifier = CommandCenterComplianceVerifier(_conn)
        cc_report = cc_verifier.verify()
        cc_compliance = {
            "compliant": cc_report.compliant,
            "summary": cc_report.summary,
            "missing_db_keys": cc_report.missing_db_keys,
            "missing_view_keys": cc_report.missing_view_keys,
            "missing_widgets": cc_report.missing_widgets,
            "write_lock": cc_report.write_lock,
            "cc_warnings": cc_report.warnings,
        }
        if not cc_report.compliant:
            warnings.append(f"command_center_not_compliant:{cc_report.summary}")
    except Exception:
        cc_compliance = {"error": "verifier_unavailable"}

    # Views Registry compliance (read-only detection + optional self-heal)
    views_registry_status: dict[str, Any] = {}
    try:
        from packages.agencyu.notion.views_registry.checks import (
            find_missing_view_keys,
            required_view_keys_minimum,
        )
        from packages.agencyu.notion.views_registry.ensure import (
            ViewsRegistryEnsurer,
            resolve_views_registry_db_id,
        )
        from packages.agencyu.notion.client import NotionClient
        from packages.agencyu.notion.notion_api import NotionAPI
        from packages.agencyu.notion.system_state import SystemState

        api = NotionAPI(client=NotionClient())
        vr_db_id = resolve_views_registry_db_id(api)
        required_keys = required_view_keys_minimum()

        if vr_db_id:
            missing_keys = find_missing_view_keys(
                api,
                views_registry_db_id=vr_db_id,
                required_keys=required_keys,
            )
        else:
            missing_keys = list(required_keys)

        # Optional self-heal
        fix_result = None
        if self_heal and missing_keys:
            sys_state = SystemState(_conn)
            guard = sys_state.mutation_guard(
                request_mutations=True,
                default_safe_mode=False,
            )
            if guard.allow_mutations:
                ensurer = ViewsRegistryEnsurer(api)
                fix_result = ensurer.ensure_cc_compliant(
                    allow_mutations=True,
                    safe_mode=False,
                    reason=f"system_health_self_heal:{guard.reason}",
                )
                # Refresh missing keys after fix
                if vr_db_id:
                    missing_keys = find_missing_view_keys(
                        api,
                        views_registry_db_id=vr_db_id,
                        required_keys=required_keys,
                    )
            else:
                fix_result = {
                    "blocked": True,
                    "reason": guard.reason,
                    "write_lock": guard.write_lock,
                    "cooldown_active": guard.cooldown_active,
                }

        # Last views_registry reconcile timestamp
        sys_state_for_ts = SystemState(_conn)
        last_vr_reconcile = sys_state_for_ts.last_reconcile_ts("views_registry")

        views_registry_status = {
            "required_count": len(required_keys),
            "missing_count": len(missing_keys),
            "missing_keys": missing_keys,
            "self_heal_requested": self_heal,
            "fix_result": fix_result,
            "last_reconcile_ts": last_vr_reconcile,
        }

        if missing_keys:
            warnings.append(f"missing_views_registry_keys:{len(missing_keys)}")
    except Exception:
        views_registry_status = {"error": "views_registry_check_unavailable"}

    # Brand switcher verification
    brand_switcher_status: dict[str, Any] = {}
    try:
        from packages.agencyu.notion.widgets.brand_switcher_verifier import (
            BrandSwitcherVerifier,
        )

        bs_verifier = BrandSwitcherVerifier(_conn)
        bs_result = bs_verifier.verify()
        brand_switcher_status = bs_result
        if not bs_result.get("ok"):
            missing_items = bs_result.get("missing", [])
            warnings.append(f"brand_switcher_issues:{len(missing_items)}")
    except Exception:
        brand_switcher_status = {"error": "brand_switcher_check_unavailable"}

    # WebOps health (last run summary from sqlite, no live API calls)
    webops_status: dict[str, Any] = {}
    try:
        webops_last_ts = get_last_success_ts(_conn, job_name="webops_checks")
        webops_status = {"last_success_ts": webops_last_ts}

        if webops_last_ts:
            wop_ts = _parse_iso(webops_last_ts)
            if wop_ts is None or wop_ts < cutoff:
                warnings.append(f"webops_last_success_stale_over_{stale_hours}h")
        else:
            warnings.append("webops_never_run")
    except Exception:
        webops_status = {"error": "webops_status_unavailable"}

    # Schedule sync freshness
    schedule_status: dict[str, Any] = {}
    try:
        from packages.agencyu.schedule.sync_engine import get_last_sync_run

        schedule_jobs = ["schedule_pull_gcal", "schedule_pull_trello_due", "schedule_reconcile"]
        schedule_last: dict[str, Any] = {}
        for sj in schedule_jobs:
            run = get_last_sync_run(_conn, sj)
            schedule_last[sj] = run

            if run is None:
                warnings.append(f"schedule_never_run:{sj}")
            elif run.get("status") == "error":
                warnings.append(f"schedule_last_run_error:{sj}")
            else:
                finished = _parse_iso(run.get("finished_at"))
                if finished and finished < cutoff:
                    warnings.append(f"schedule_stale_over_{stale_hours}h:{sj}")

        # Active event count
        sched_total = _conn.execute(
            "SELECT COUNT(*) FROM schedule_events WHERE status != 'cancelled'"
        ).fetchone()[0]
        sched_conflicts = _conn.execute(
            "SELECT COUNT(*) FROM schedule_events WHERE conflict_flag=1 AND status != 'cancelled'"
        ).fetchone()[0]

        schedule_status = {
            "last_runs": schedule_last,
            "active_events": sched_total,
            "conflicts": sched_conflicts,
        }

        if sched_conflicts > 0:
            warnings.append(f"schedule_conflicts:{sched_conflicts}")
    except Exception:
        schedule_status = {"error": "schedule_status_unavailable"}

    return {
        "ok": True,
        "warnings": warnings,
        "cooldown": cooldown,
        "queue": {"scheduled_actions_pending": depth},
        "notion_compliance_status": notion_compliance,
        "command_center_compliance": cc_compliance,
        "views_registry": views_registry_status,
        "brand_switcher": brand_switcher_status,
        "schedule": schedule_status,
        "webops": webops_status,
        "last_heal_ts": last_heal_ts,
        "agencyu": {
            "nurture_pending": nurture_pending,
            "momentum_pending": momentum_pending,
            "attribution_backlog": attribution_backlog,
            "last_nurture_run": last_success.get("nurture_tick"),
            "last_momentum_run": last_success.get("momentum_tick"),
        },
        "capacity": get_capacity_overview(_conn),
        "replay_buffer": get_buffer_stats(_conn),
        "recent_job_runs": recent,
        "last_success": last_success,
        "thresholds": {
            "queue_depth_threshold": settings.HEALTH_WARN_QUEUE_DEPTH_THRESHOLD,
            "reconcile_stale_hours": settings.HEALTH_WARN_RECONCILE_STALE_HOURS,
        },
    }
