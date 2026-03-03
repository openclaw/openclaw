#!/usr/bin/env bash

meta_alerts_evaluate() {
  local now_ts="${META_NOW_TS:-$(date +%s)}"
  local cron_last_ts="${META_CRON_LAST_HEALTH_TS:-0}"

  local low_completeness_streak="${META_CONSEC_LOW_COMPLETENESS:-0}"
  local timeout_rate="${META_STEP_TIMEOUT_RATE:-0}"
  local empty_workload_24h="${META_EMPTY_WORKLOAD_24H:-0}"
  local ambiguous_empty_24h="${META_AMBIG_EMPTY_24H:-0}"
  local stale_timeout_trend="${META_STALE_TIMEOUT_TREND:-0}"

  if [[ "$low_completeness_streak" -ge 5 ]]; then
    printf 'low_evidence_completeness\thigh\tevidence completeness below 60%% across 5 incidents\n'
  fi

  awk -v r="$timeout_rate" 'BEGIN { exit (r + 0 > 10 ? 0 : 1) }' && \
    printf 'step_timeout_rate\tmedium\tstep timeout rate above 10%%\n'

  if [[ "$empty_workload_24h" -gt 3 ]]; then
    printf 'incident_id_empty_workload\tmedium\tempty-workload incident-id events above 3 in 24h\n'
  fi

  if [[ "$ambiguous_empty_24h" -gt 5 ]]; then
    printf 'incident_id_ambiguous_empty_workload\thigh\tambiguous empty-workload routes above 5 in 24h\n'
  fi

  if [[ "$cron_last_ts" -gt 0 && $((now_ts - cron_last_ts)) -gt 5400 ]]; then
    printf 'cron_health_missing\thigh\tcron healthcheck sentinel missing for over 90m\n'
  fi

  awk -v t="$stale_timeout_trend" 'BEGIN { exit (t + 0 > 0 ? 0 : 1) }' && \
    printf 'stale_timeout_trending_up\tmedium\tstale timeout frequency trending up\n'
}

meta_alerts_from_file() {
  local metrics_file="$1"
  [[ -f "$metrics_file" ]] || return 1

  while IFS=$'\t' read -r key value; do
    case "$key" in
      consec_low_completeness) META_CONSEC_LOW_COMPLETENESS="$value" ;;
      step_timeout_rate) META_STEP_TIMEOUT_RATE="$value" ;;
      empty_workload_24h) META_EMPTY_WORKLOAD_24H="$value" ;;
      ambiguous_empty_24h) META_AMBIG_EMPTY_24H="$value" ;;
      cron_last_health_ts) META_CRON_LAST_HEALTH_TS="$value" ;;
      stale_timeout_trend) META_STALE_TIMEOUT_TREND="$value" ;;
    esac
  done <"$metrics_file"

  meta_alerts_evaluate
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  meta_alerts_evaluate
fi
