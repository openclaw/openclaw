#!/usr/bin/env bash

HYPOTHESIS_RECOLLECT_MAX_RETRIES="${HYPOTHESIS_RECOLLECT_MAX_RETRIES:-1}"
HYPOTHESIS_RECOLLECT_BUDGET_MS="${HYPOTHESIS_RECOLLECT_BUDGET_MS:-15000}"

hypothesis_recollect_should_run() {
  local confidence="${1:-0}"
  local gap_json="${2-}"
  local attempts="${3:-0}"
  local elapsed_ms="${4:-0}"
  local missing_critical_count=0
  local collectors=""
  [[ -n "$gap_json" ]] || gap_json='{}'

  [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
  [[ "$elapsed_ms" =~ ^[0-9]+$ ]] || elapsed_ms=0
  [[ "$confidence" =~ ^[0-9]+([.][0-9]+)?$ ]] || confidence=0
  if (( attempts >= HYPOTHESIS_RECOLLECT_MAX_RETRIES )); then
    return 1
  fi
  if (( elapsed_ms >= HYPOTHESIS_RECOLLECT_BUDGET_MS )); then
    return 1
  fi
  if ! missing_critical_count="$(printf '%s\n' "$gap_json" | jq -r '(.missing_critical // []) | length' 2>/dev/null)"; then
    missing_critical_count=0
  fi
  missing_critical_count="${missing_critical_count%%$'\n'*}"
  case "$missing_critical_count" in
    '' | *[!0-9]*)
      missing_critical_count=0
      ;;
  esac
  if (( missing_critical_count == 0 )); then
    return 1
  fi
  collectors="$(hypothesis_recollect_collectors "$gap_json" 2>/dev/null || true)"
  [[ -n "$collectors" ]]
}

hypothesis_recollect_collectors() {
  local gap_json="${1-}"
  [[ -n "$gap_json" ]] || gap_json='{}'
  printf '%s\n' "$gap_json" \
    | jq -r '
        (.missing_critical // [])
        | map(
            if . == "pod_issues" or . == "deploy_gaps" then "step_01_pod_deploy"
            elif . == "critical_alerts" or . == "log_signals" then "step_02_events_alerts"
            elif . == "prom_critical" then "step_03_prometheus_trends"
            elif . == "argocd_sync" then "step_04_argocd_sync"
            elif . == "cert_critical" then "step_06_cert_secret_health"
            elif . == "aws_critical" then "step_07_aws_resource_signals"
            elif . == "changes_in_window" then "collect_change_window_context"
            elif . == "config_drift" or . == "config_lineage" then "collect_phase2_drift_and_lineage"
            elif . == "db_schema_check" or . == "db_data_check" or . == "pg_internal_check" or . == "replica_lag" or . == "pg_activity" or . == "pg_statements" or . == "pg_conflicts" or . == "db_topology" then "collect_phase2_db_evidence"
            elif . == "image_revision" then "step_09_revisions"
            elif . == "ci_signal" then "step_10_ci_signals"
            else empty
            end
          )
        | unique
        | .[]
      ' 2>/dev/null
}

hypothesis_recollect_note() {
  local category="${1:-unknown}"
  local gap_json="${2-}"
  local attempt="${3:-1}"
  local missing
  [[ -n "$gap_json" ]] || gap_json='{}'
  missing="$(printf '%s\n' "$gap_json" | jq -r '(.missing_critical // []) | join(",")' 2>/dev/null || true)"
  printf 'recollect attempt %s for %s due to missing critical evidence: %s\n' "$attempt" "$category" "${missing:-unknown}"
}
