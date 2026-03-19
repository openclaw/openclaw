#!/usr/bin/env bash

HYPOTHESIS_RECOLLECT_MAX_RETRIES="${HYPOTHESIS_RECOLLECT_MAX_RETRIES:-1}"
HYPOTHESIS_RECOLLECT_BUDGET_MS="${HYPOTHESIS_RECOLLECT_BUDGET_MS:-15000}"

hypothesis_recollect_should_run() {
  local confidence="${1:-0}"
  local gap_json="${2-}"
  local attempts="${3:-0}"
  local elapsed_ms="${4:-0}"
  local category="${5:-unknown}"
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
  collectors="$(hypothesis_recollect_collectors "$gap_json" "$category" 2>/dev/null || true)"
  [[ -n "$collectors" ]]
}

hypothesis_recollect_collectors_for_category() {
  local category="${1:-unknown}"
  case "$category" in
    bad_deploy)
      printf '%s\n' step_01_pod_deploy collect_change_window_context collect_phase2_drift_and_lineage
      ;;
    config_drift)
      printf '%s\n' collect_phase2_drift_and_lineage collect_change_window_context
      ;;
    resource_exhaustion)
      printf '%s\n' step_01_pod_deploy step_03_prometheus_trends collect_change_window_context
      ;;
    network_connectivity | dependency_failure)
      printf '%s\n' step_02_events_alerts step_07_aws_resource_signals collect_change_window_context
      ;;
    cert_or_secret_expiry)
      printf '%s\n' step_06_cert_secret_health collect_phase2_drift_and_lineage
      ;;
    scaling_issue)
      printf '%s\n' step_01_pod_deploy step_03_prometheus_trends collect_change_window_context
      ;;
    data_issue)
      printf '%s\n' step_02_events_alerts collect_phase2_db_evidence collect_change_window_context collect_phase2_rewards_provider_context_if_available
      ;;
    *)
      printf '%s\n' collect_change_window_context
      ;;
  esac
}

hypothesis_recollect_collectors() {
  local gap_json="${1-}"
  local category="${2:-unknown}"
  local missing_gap collector_lines=""
  [[ -n "$gap_json" ]] || gap_json='{}'

  while IFS= read -r missing_gap; do
    [[ -n "$missing_gap" ]] || continue
    case "$missing_gap" in
      primary_symptom_unexplained)
        collector_lines="${collector_lines}$(hypothesis_recollect_collectors_for_category "$category")"$'\n'
        ;;
      pod_issues | deploy_gaps)
        collector_lines="${collector_lines}step_01_pod_deploy"$'\n'
        ;;
      critical_alerts | log_signals)
        collector_lines="${collector_lines}step_02_events_alerts"$'\n'
        ;;
      prom_critical)
        collector_lines="${collector_lines}step_03_prometheus_trends"$'\n'
        ;;
      argocd_sync)
        collector_lines="${collector_lines}step_04_argocd_sync"$'\n'
        ;;
      cert_critical)
        collector_lines="${collector_lines}step_06_cert_secret_health"$'\n'
        ;;
      aws_critical)
        collector_lines="${collector_lines}step_07_aws_resource_signals"$'\n'
        ;;
      changes_in_window)
        collector_lines="${collector_lines}collect_change_window_context"$'\n'
        ;;
      config_drift | config_lineage)
        collector_lines="${collector_lines}collect_phase2_drift_and_lineage"$'\n'
        ;;
      db_schema_check | db_data_check | pg_internal_check | replica_lag | pg_activity | pg_statements | pg_conflicts | db_topology)
        collector_lines="${collector_lines}collect_phase2_db_evidence"$'\n'
        ;;
      image_revision)
        collector_lines="${collector_lines}step_09_revisions"$'\n'
        ;;
      ci_signal)
        collector_lines="${collector_lines}step_10_ci_signals"$'\n'
        ;;
    esac
  done < <(printf '%s\n' "$gap_json" | jq -r '(.missing_critical // [])[]?' 2>/dev/null || true)

  printf '%s' "$collector_lines" | awk 'NF > 0 && !seen[$0]++ { print }'
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
