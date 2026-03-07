from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends

from packages.agencyu.attribution.engine import AttributionEngine
from packages.agencyu.boot.system_validator import SystemValidator
from packages.agencyu.intelligence.campaign_integrity import (
    get_campaign_integrity,
    get_integrity_summary,
    refresh_campaign_integrity,
)
from packages.agencyu.intelligence.client_health import (
    get_all_health_scores,
    get_churn_risks,
    get_health_summary,
)
from packages.agencyu.notion.client import NotionClient
from packages.agencyu.notion.compliance_verifier import NotionComplianceVerifier
from packages.agencyu.notion.drift_healer import DriftHealer
from packages.agencyu.notion.manifest_validator import NotionManifestValidator
from packages.agencyu.notion.notion_api import NotionAPI
from packages.agencyu.notion.notion_mirror import NotionMirror
from packages.agencyu.notion.schema_bootstrap import NotionSchemaBootstrapper
from packages.agencyu.notion_os.mirror import CanonicalNotionMirror
from packages.agencyu.sync.backup_jobs import (
    backup_notion_snapshot,
    backup_sqlite,
    backup_trello_metadata,
    get_backup_history,
)
from packages.agencyu.sync.capacity import get_capacity_overview
from packages.agencyu.sync.orchestrator import SyncOrchestrator
from packages.agencyu.sync.replay_buffer import get_buffer_stats
from packages.agencyu.sync.revenue_forecast import get_forecast, get_recent_forecasts
from packages.agencyu.services.notion_audit_writer import NotionAuditWriter, NotionAuditWriterConfig
from packages.agencyu.services.state_pruner import prune_old_audit_logs, prune_recent_job_stops
from packages.agencyu.services.system_state import SystemKeys, SystemState
from packages.agencyu.sync.views_registry import get_views_status, seed_views_registry
from packages.common.config import settings
from packages.common.db import connect, init_schema
from packages.common.logging import get_logger
from services.webhook_gateway.ops_security import require_admin_ops_token

log = get_logger("admin.agencyos")

router = APIRouter()

_conn = connect(settings.SQLITE_PATH)
init_schema(_conn)


# ── Health ──


@router.get("/health")
def agencyos_health(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """AgencyOS comprehensive health: counts, compliance, capacity, replay buffer."""
    bindings_count = _conn.execute("SELECT COUNT(*) FROM notion_bindings").fetchone()[0]
    id_map_count = _conn.execute("SELECT COUNT(*) FROM id_map").fetchone()[0]
    wom_count = _conn.execute("SELECT COUNT(*) FROM work_order_mirror").fetchone()[0]
    attr_count = _conn.execute("SELECT COUNT(*) FROM attribution_snapshot").fetchone()[0]
    cf_count = _conn.execute("SELECT COUNT(*) FROM clickfunnels_events").fetchone()[0]
    nm_count = _conn.execute("SELECT COUNT(*) FROM notion_mirrors").fetchone()[0]
    ce_count = _conn.execute("SELECT COUNT(*) FROM canonical_entities WHERE is_deleted=0").fetchone()[0]
    em_count = _conn.execute("SELECT COUNT(*) FROM entity_mappings").fetchone()[0]
    nms_count = _conn.execute("SELECT COUNT(*) FROM notion_mirror_state").fetchone()[0]
    cl_count = _conn.execute("SELECT COUNT(*) FROM conflict_log").fetchone()[0]

    # Compliance status (lightweight — no API calls)
    validator = NotionManifestValidator(_conn)
    compliance = validator.validate()

    return {
        "ok": True,
        "notion_write_enabled": settings.NOTION_WRITE_ENABLED,
        "notion_write_lock": settings.NOTION_WRITE_LOCK,
        "dry_run": settings.DRY_RUN,
        "safe_mode": settings.SAFE_MODE,
        "compliance": {
            "compliant": compliance.compliant,
            "total_issues": len(compliance.issues),
            "healable": compliance.healable_count,
            "manual": compliance.manual_count,
            "manifest_version": compliance.manifest_version,
        },
        "counts": {
            "notion_bindings": bindings_count,
            "id_map": id_map_count,
            "work_order_mirrors": wom_count,
            "notion_mirrors": nm_count,
            "attribution_snapshots": attr_count,
            "clickfunnels_events": cf_count,
            "canonical_entities": ce_count,
            "entity_mappings": em_count,
            "notion_mirror_state": nms_count,
            "conflict_log": cl_count,
        },
        "capacity": get_capacity_overview(_conn),
        "replay_buffer": get_buffer_stats(_conn),
    }


# ── Notion Bootstrap ──


@router.post("/notion/bootstrap")
def notion_bootstrap(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Plan or execute Notion schema bootstrap."""
    notion = NotionClient()
    bootstrapper = NotionSchemaBootstrapper(_conn, notion)

    if settings.DRY_RUN:
        plan = bootstrapper.plan()
        return {"dry_run": True, "databases": plan.databases, "bindings": plan.bindings}

    return bootstrapper.execute()


# ── Notion Sync Status ──


@router.get("/notion/sync-status")
def notion_sync_status(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Return Notion mirror sync status (both v2 and canonical)."""
    notion = NotionClient()
    v2_mirror = NotionMirror(_conn, notion)
    canonical_mirror = CanonicalNotionMirror(_conn, notion)
    return {
        "v2": v2_mirror.get_sync_status(),
        "canonical": canonical_mirror.get_mirror_stats(),
    }


# ── Manifest Compliance ──


@router.get("/manifest/compliance")
def manifest_compliance(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Full compliance report against YAML template manifest."""
    validator = NotionManifestValidator(_conn)
    result = validator.validate()
    return {
        "compliant": result.compliant,
        "manifest_version": result.manifest_version,
        "healable_count": result.healable_count,
        "manual_count": result.manual_count,
        "issues": [asdict(i) for i in result.issues],
    }


@router.post("/manifest/heal")
def manifest_heal(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Attempt to auto-heal healable compliance issues."""
    notion = NotionClient()
    healer = DriftHealer(_conn, notion)
    result = healer.heal()
    return {
        "dry_run": result.dry_run,
        "healed_count": result.healed_count,
        "skipped_count": result.skipped_count,
        "error_count": result.error_count,
        "actions": [asdict(a) for a in result.actions],
    }


# ── Sync Orchestrator ──


@router.get("/sync/overview")
def sync_overview(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """High-level sync overview."""
    orchestrator = SyncOrchestrator(_conn)
    return orchestrator.get_sync_overview()


@router.get("/sync/runs")
def sync_runs(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Recent sync runs."""
    orchestrator = SyncOrchestrator(_conn)
    return {"runs": orchestrator.get_recent_runs(limit=20)}


@router.get("/sync/conflicts")
def sync_conflicts(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Recent drift conflicts."""
    orchestrator = SyncOrchestrator(_conn)
    return {"conflicts": orchestrator.get_conflicts(limit=50)}


# ── Replay Buffer ──


@router.get("/replay/stats")
def replay_stats(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Event replay buffer statistics."""
    return get_buffer_stats(_conn)


# ── Capacity ──


@router.get("/capacity")
def capacity_overview(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Team capacity overview."""
    return get_capacity_overview(_conn)


# ── Revenue Forecast ──


@router.get("/forecast")
def forecast_list(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Recent revenue forecasts."""
    return {"forecasts": get_recent_forecasts(_conn, limit=6)}


@router.get("/forecast/{month}")
def forecast_detail(
    month: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get forecast for a specific month (YYYY-MM)."""
    forecast = get_forecast(_conn, month)
    if not forecast:
        return {"error": "not_found", "month": month}
    return forecast


# ── Attribution ──


@router.get("/attribution/{contact_key}")
def get_attribution(
    contact_key: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get attribution snapshot for a contact."""
    engine = AttributionEngine(_conn)
    snapshot = engine.get_snapshot(contact_key)
    if not snapshot:
        return {"error": "not_found", "contact_key": contact_key}
    return snapshot


@router.get("/attribution/campaign/{utm_campaign}")
def get_campaign_roas(
    utm_campaign: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get ROAS metrics for a campaign."""
    engine = AttributionEngine(_conn)
    return engine.get_campaign_roas(utm_campaign)


# ── Intelligence: Client Health & Churn ──


@router.get("/intelligence/churn-risks")
def churn_risks(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get clients at churn risk."""
    return {
        "risks": get_churn_risks(_conn, min_risk="medium"),
        "summary": get_health_summary(_conn),
    }


@router.get("/intelligence/client-health")
def client_health(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get all client health scores (worst first)."""
    return {
        "scores": get_all_health_scores(_conn),
        "summary": get_health_summary(_conn),
    }


# ── Intelligence: Campaign Integrity ──


@router.get("/intelligence/campaign-integrity")
def campaign_integrity(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get campaign attribution integrity report."""
    return {
        "campaigns": get_campaign_integrity(_conn),
        "summary": get_integrity_summary(_conn),
    }


@router.post("/intelligence/campaign-integrity/refresh")
def campaign_integrity_refresh(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Refresh campaign integrity from attribution snapshots."""
    results = refresh_campaign_integrity(_conn)
    return {
        "refreshed": len(results),
        "campaigns": results,
    }


# ── Boot Validation ──


@router.post("/system/validate")
def system_validate(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run boot-time system validation across all subsystems."""
    validator = SystemValidator(_conn)
    results = validator.validate_all()
    return {
        "results": [{"subsystem": r.subsystem, "status": r.status, "details": r.details} for r in results],
        "ok_count": sum(1 for r in results if r.status == "ok"),
        "warning_count": sum(1 for r in results if r.status == "warning"),
        "error_count": sum(1 for r in results if r.status == "error"),
    }


@router.get("/system/last-validation")
def last_validation(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get results from the most recent system validation."""
    validator = SystemValidator(_conn)
    return {"validations": validator.get_last_validation()}


# ── Compliance Verifier (Full V2) ──


@router.get("/system/manifest")
def system_manifest_compliance(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Full compliance report using the V2 compliance verifier.

    Read-only — no mutations. Uses Views Registry for view verification.
    """
    if not settings.NOTION_API_KEY or not settings.NOTION_ROOT_PAGE_ID:
        return {
            "ok": False,
            "error": "NOTION_API_KEY or NOTION_ROOT_PAGE_ID not configured",
        }

    notion_client = NotionClient()
    notion_api = NotionAPI(notion_client)
    verifier = NotionComplianceVerifier(
        notion_api=notion_api,
        conn=_conn,
        root_page_id=settings.NOTION_ROOT_PAGE_ID,
    )
    report = verifier.verify()
    verifier.persist_report(report)

    return {
        "ok": report.ok,
        "manifest_version": report.manifest_version,
        "databases_checked": report.databases_checked,
        "databases_missing": report.databases_missing,
        "total_issues": len(report.issues),
        "critical": report.critical_count,
        "healable": report.healable_count,
        "manual": report.manual_count,
        "elapsed_ms": report.elapsed_ms,
        "issues": [
            {
                "database": i.database,
                "issue_type": i.issue_type,
                "property_name": i.property_name,
                "severity": i.severity.value,
                "details": i.details,
                "healable": i.healable,
            }
            for i in report.issues
        ],
    }


@router.post("/system/manifest/heal")
def system_manifest_heal(
    simulate: bool = True,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Heal drift issues detected by manifest compliance check.

    Default: simulate=true (dry-run, no mutations).
    Pass simulate=false to apply (only if write-enabled and no CRITICAL drift).
    """
    notion = NotionClient()
    healer = DriftHealer(_conn, notion)
    result = healer.heal()

    return {
        "dry_run": result.dry_run,
        "healed_count": result.healed_count,
        "skipped_count": result.skipped_count,
        "error_count": result.error_count,
        "actions": [asdict(a) for a in result.actions],
    }


# ── Views Registry ──


@router.post("/system/views-registry/seed")
def seed_views(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Seed the views registry from the template manifest."""
    count = seed_views_registry(_conn)
    return {"seeded": count}


@router.get("/system/views-registry")
def views_registry_status(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get views registry status."""
    return get_views_status(_conn)


# ── Portal Compliance ──


@router.get("/system/portal-compliance/{client_id}")
def portal_compliance_check(
    client_id: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Check client portal compliance (required sections)."""
    from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

    verifier = PortalComplianceVerifier(_conn)
    result = verifier.verify_portal(client_id)
    return {
        "client_id": result.client_id,
        "compliant": result.compliant,
        "missing_sections": result.missing_sections,
        "issues": [asdict(i) for i in result.issues],
    }


@router.post("/system/portal-compliance/{client_id}/heal")
def portal_compliance_heal(
    client_id: str,
    simulate: bool = True,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Heal client portal by adding missing section headings."""
    from packages.agencyu.notion.portal_compliance import PortalComplianceVerifier

    notion = NotionClient()
    verifier = PortalComplianceVerifier(_conn, notion)
    result = verifier.heal_portal(client_id, simulate=simulate)
    return {
        "client_id": result.client_id,
        "simulate": result.simulate,
        "healed_sections": result.healed_sections,
        "skipped_sections": result.skipped_sections,
        "errors": result.errors,
    }


# ── Backup Jobs ──


@router.post("/system/backup/sqlite")
def backup_sqlite_endpoint(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Snapshot the SQLite database."""
    result = backup_sqlite(_conn)
    return {
        "backup_id": result.backup_id,
        "status": result.status,
        "file_path": result.file_path,
        "checksum": result.checksum,
        "size_bytes": result.size_bytes,
        "details": result.details,
    }


@router.post("/system/backup/trello")
def backup_trello_endpoint(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Export Trello metadata to JSON."""
    result = backup_trello_metadata(_conn)
    return {
        "backup_id": result.backup_id,
        "status": result.status,
        "file_path": result.file_path,
        "size_bytes": result.size_bytes,
        "details": result.details,
    }


@router.post("/system/backup/notion")
def backup_notion_endpoint(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Snapshot Notion mirror state to JSON."""
    result = backup_notion_snapshot(_conn)
    return {
        "backup_id": result.backup_id,
        "status": result.status,
        "file_path": result.file_path,
        "size_bytes": result.size_bytes,
        "details": result.details,
    }


@router.get("/system/backup/history")
def backup_history(
    backup_type: str | None = None,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get recent backup runs."""
    return {"backups": get_backup_history(_conn, backup_type=backup_type)}


# ── System Audit Log ──


@router.get("/system/audit-log")
def system_audit_log(
    limit: int = 50,
    system: str | None = None,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Get recent system audit log entries."""
    if system:
        rows = _conn.execute(
            "SELECT * FROM system_audit_log WHERE system=? ORDER BY timestamp DESC LIMIT ?",
            (system, limit),
        ).fetchall()
    else:
        rows = _conn.execute(
            "SELECT * FROM system_audit_log ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"entries": [dict(r) for r in rows]}


# ── Enhanced HealPlan API ──


@router.post("/system/audit-mirror")
def system_audit_mirror(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run the audit log mirroring job (SQLite → Notion System Audit Log).

    Simulates by default unless SAFE_MODE=false, NOTION_WRITE_ENABLED=true,
    and NOTION_WRITE_LOCK=false.
    """
    from packages.common.ids import new_id

    corr_id = new_id("corr")
    notion_client = NotionClient()
    notion_api = NotionAPI(notion_client)
    writer = NotionAuditWriter(_conn, notion_api)
    result = writer.run(correlation_id=corr_id)
    return result


@router.get("/system/health")
def system_health(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """System health: cooldown status, reconcile timestamps, queue depth, recent failures, warnings."""
    import time as _time

    state = SystemState(_conn)

    # Cooldown / circuit breaker
    cooldown_until = state.get_int(SystemKeys.NOTION_AUDIT_MIRROR_COOLDOWN_UNTIL_EPOCH, default=0) or 0
    now_epoch = int(_time.time())
    cooldown_active = now_epoch < cooldown_until if cooldown_until else False
    last_trip_reason = state.get_str(SystemKeys.NOTION_AUDIT_MIRROR_LAST_TRIP_REASON, default="") or ""

    # Queue depth: live count from scheduled_actions
    try:
        q_row = _conn.execute("SELECT COUNT(1) FROM scheduled_actions WHERE status='pending'").fetchone()
        queue_depth = int(q_row[0]) if q_row else 0
        queue_source = "live"
    except Exception:
        queue_depth = state.get_int(SystemKeys.QUEUE_DEPTH_SCHEDULED_ACTIONS, default=0) or 0
        queue_source = "state"

    # Reconcile timestamps
    last_reconcile_success = state.get_str(SystemKeys.LAST_RECONCILE_SUCCESS_AT)
    last_reconcile_attempt = state.get_str(SystemKeys.LAST_RECONCILE_ATTEMPT_AT)

    # Recent job stop reasons (ring buffer)
    recent_stops = state.get_json(
        SystemKeys.RECENT_JOB_STOPS_JSON, default={"items": []}
    ).get("items", [])[:10]

    # Recent audit failures
    try:
        fail_rows = _conn.execute(
            "SELECT ts, correlation_id, system, action, target, result, stop_reason "
            "FROM audit_logs WHERE result IN ('failed','blocked') "
            "ORDER BY ts DESC LIMIT 10"
        ).fetchall()
        recent_failures = [dict(r) for r in fail_rows]
    except Exception:
        recent_failures = []

    # Warnings
    warnings: list[str] = []
    if cooldown_active:
        warnings.append("circuit_breaker_cooldown_active")
    if queue_depth > 500:
        warnings.append("queue_depth_over_500")
    if last_reconcile_success:
        try:
            t = _time.strptime(last_reconcile_success, "%Y-%m-%dT%H:%M:%SZ")
            last_epoch = int(_time.mktime(t))
            if now_epoch - last_epoch > 24 * 3600:
                warnings.append("no_reconcile_success_in_24h")
        except Exception:
            warnings.append("reconcile_timestamp_unreadable")

    return {
        "ok": len(warnings) == 0,
        "ts": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
        "cooldown": {
            "active": cooldown_active,
            "until_epoch": cooldown_until,
            "last_trip_reason": last_trip_reason,
        },
        "queue": {
            "scheduled_actions_pending": queue_depth,
            "source": queue_source,
        },
        "reconcile": {
            "last_success_at": last_reconcile_success,
            "last_attempt_at": last_reconcile_attempt,
        },
        "recent_job_stop_reasons": recent_stops,
        "recent_failures": recent_failures,
        "warnings": warnings,
    }


@router.get("/system/state")
def system_state_snapshot(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Read-only system state snapshot: versions, flags, cooldown, queue, reconcile, recent stops."""
    import time as _time

    state = SystemState(_conn)

    # Cooldown
    cooldown_until = state.get_int(SystemKeys.NOTION_AUDIT_MIRROR_COOLDOWN_UNTIL_EPOCH, default=0) or 0
    now_epoch = int(_time.time())
    cooldown_active = now_epoch < cooldown_until if cooldown_until else False

    # Queue depth
    try:
        q_row = _conn.execute("SELECT COUNT(1) FROM scheduled_actions WHERE status='pending'").fetchone()
        queue_depth = int(q_row[0]) if q_row else 0
    except Exception:
        queue_depth = state.get_int(SystemKeys.QUEUE_DEPTH_SCHEDULED_ACTIONS, default=0) or 0

    # Recent stops
    recent_stops = state.get_json(
        SystemKeys.RECENT_JOB_STOPS_JSON, default={"items": []}
    ).get("items", [])[:20]

    return {
        "template_version": "v13",
        "os_version": "openclaw-v13-marketing-core",
        "write_lock": getattr(settings, "NOTION_WRITE_LOCK", True),
        "safe_mode": getattr(settings, "SAFE_MODE", True),
        "dry_run": getattr(settings, "DRY_RUN", True),
        "notion_write_enabled": getattr(settings, "NOTION_WRITE_ENABLED", False),
        "cooldown_active": cooldown_active,
        "cooldown_until_epoch": cooldown_until,
        "queue_depth": queue_depth,
        "recent_job_stops": recent_stops,
        "last_reconcile_success": state.get_str(SystemKeys.LAST_RECONCILE_SUCCESS_AT),
        "last_reconcile_attempt": state.get_str(SystemKeys.LAST_RECONCILE_ATTEMPT_AT),
        "ts": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }


@router.post("/system/prune")
def system_prune(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Run state pruning: trim ring buffers and old audit logs."""
    stops_result = prune_recent_job_stops(_conn)
    audit_result = prune_old_audit_logs(_conn)
    return {
        "job_stops": stops_result,
        "audit_logs": audit_result,
    }


@router.post("/system/manifest/simulate")
def system_manifest_simulate(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Simulate a heal plan without executing (dry-run planning)."""
    notion = NotionClient()
    healer = DriftHealer(_conn, notion)
    plan = healer.simulate()
    return {
        "ok_to_apply": plan.ok_to_apply,
        "manifest_hash": plan.manifest_hash,
        "blocked_reasons": plan.blocked_reasons,
        "action_count": len(plan.actions),
        "actions": [
            {
                "action_type": a.action_type,
                "database_key": a.database_key,
                "description": a.description,
            }
            for a in plan.actions
        ],
    }


@router.post("/system/manifest/apply")
def system_manifest_apply(
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Apply a heal plan (requires write permissions)."""
    notion = NotionClient()
    healer = DriftHealer(_conn, notion)
    plan = healer.apply()
    return {
        "ok_to_apply": plan.ok_to_apply,
        "manifest_hash": plan.manifest_hash,
        "blocked_reasons": plan.blocked_reasons,
        "action_count": len(plan.actions),
        "actions": [
            {
                "action_type": a.action_type,
                "database_key": a.database_key,
                "description": a.description,
            }
            for a in plan.actions
        ],
    }


# ── Policy Debug Explain ──


@router.get("/policy/explain")
def policy_explain(
    combo_id: str,
    _: None = Depends(require_admin_ops_token),
) -> dict[str, Any]:
    """Explain why a combo was held/killed/scaled/rotated.

    Re-runs the decision pipeline for a single combo in trace mode.
    Returns structured trace + human-readable explanation lines.

    Usage: GET /admin/agencyos/policy/explain?combo_id=combo_abc123
    """
    from packages.agencyu.marketing.debug import policy_debug_explain

    return policy_debug_explain(combo_id, conn=_conn)
