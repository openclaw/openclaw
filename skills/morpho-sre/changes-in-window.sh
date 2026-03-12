#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${SCRIPT_DIR}/lib-timeline.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/lib-timeline.sh"
fi
if [[ -f "${SCRIPT_DIR}/lib-evidence-row.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/lib-evidence-row.sh"
fi

CHANGE_WINDOW_MINUTES="${CHANGE_WINDOW_MINUTES:-180}"
SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev,monitoring}"
KUBECTL_TIMEOUT="${KUBECTL_TIMEOUT:-30s}"
ARGOCD_BASE_URL="${ARGOCD_BASE_URL:-}"

ciw_now_epoch() {
  date -u +%s
}

ciw_now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

ciw_iso_to_epoch() {
  local value="${1:-}"
  [[ -n "$value" ]] || return 1
  date -u -d "$value" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$value" +%s 2>/dev/null
}

ciw_within_window() {
  local iso_ts="${1:-}"
  local epoch
  epoch="$(ciw_iso_to_epoch "$iso_ts" 2>/dev/null || true)"
  [[ -n "$epoch" ]] || return 1
  local now_epoch
  now_epoch="$(ciw_now_epoch)"
  (( now_epoch - epoch <= CHANGE_WINDOW_MINUTES * 60 ))
}

ciw_ns_allowed() {
  local ns="${1:-}"
  local item
  IFS=',' read -r -a items <<<"$SCOPE_NAMESPACES"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [[ -n "$item" ]] || continue
    [[ "$item" == "$ns" ]] && return 0
  done
  return 1
}

ciw_append_line() {
  local var_name="${1:?var_name required}"
  local line="${2:-}"
  [[ -n "$line" ]] || return 0
  local current="${!var_name:-}"
  if [[ -n "$current" ]]; then
    printf -v "$var_name" '%s\n%s' "$current" "$line"
  else
    printf -v "$var_name" '%s' "$line"
  fi
}

ciw_emit_change() {
  local source="${1:-unknown}"
  local event="${2:-unknown}"
  local scope="${3:-global}"
  local observed_at="${4:-$(ciw_now_utc)}"
  local severity="${5:-info}"
  local summary="${6:-}"
  local payload_json="${7-}"
  [[ -n "$payload_json" ]] || payload_json='{}'

  local timeline_json
  timeline_json="$(timeline_event_build "$source" "$event" "$scope" "$observed_at" "$severity" "$summary" "$payload_json")"
  ciw_append_line CIW_TIMELINE_NDJSON "$timeline_json"
  CIW_EVENT_COUNT=$((CIW_EVENT_COUNT + 1))

  if declare -F evidence_row_build >/dev/null 2>&1; then
    local evidence_json
    evidence_json="$(evidence_row_build "changes-in-window" "$event" "$scope" "$observed_at" "$payload_json" "" "70" "$((CHANGE_WINDOW_MINUTES * 60))")"
    ciw_append_line CIW_EVIDENCE_NDJSON "$evidence_json"
  fi
}

ciw_collect_argocd() {
  [[ -n "$ARGOCD_BASE_URL" ]] || return 0
  [[ -x "${SCRIPT_DIR}/argocd-sync-status.sh" ]] || return 0
  while IFS=$'\t' read -r app_name sync_status health_status last_sync_time last_sync_result drift_summary; do
    [[ -n "$app_name" && "$app_name" != "app_name" ]] || continue
    if ! ciw_within_window "$last_sync_time" && [[ "$drift_summary" != *"severity=critical"* && "$drift_summary" != *"severity=warning"* ]]; then
      continue
    fi
    local severity="info"
    [[ "$drift_summary" == *"severity=critical"* ]] && severity="critical"
    [[ "$drift_summary" == *"severity=warning"* ]] && severity="warning"
    ciw_emit_change \
      "argocd" \
      "sync_change" \
      "$app_name" \
      "${last_sync_time:-$(ciw_now_utc)}" \
      "$severity" \
      "ArgoCD ${app_name} sync=${sync_status} health=${health_status} result=${last_sync_result}" \
      "$(jq -nc --arg app_name "$app_name" --arg sync_status "$sync_status" --arg health_status "$health_status" --arg last_sync_result "$last_sync_result" --arg drift_summary "$drift_summary" '{app_name:$app_name,sync_status:$sync_status,health_status:$health_status,last_sync_result:$last_sync_result,drift_summary:$drift_summary}')"
  done < <(bash "${SCRIPT_DIR}/argocd-sync-status.sh" 2>/dev/null || true)
}

ciw_collect_pod_restarts() {
  command -v kubectl >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r ns pod restart_count; do
    [[ -n "$ns" && -n "$pod" ]] || continue
    ciw_ns_allowed "$ns" || continue
    [[ "$restart_count" =~ ^[0-9]+$ ]] || continue
    (( restart_count > 0 )) || continue
    ciw_emit_change \
      "kubernetes" \
      "pod_restart" \
      "${ns}/${pod}" \
      "$(ciw_now_utc)" \
      "$([[ "$restart_count" -ge 5 ]] && printf 'critical' || printf 'warning')" \
      "Pod ${ns}/${pod} restarted ${restart_count} times in current state" \
      "$(jq -nc --arg namespace "$ns" --arg pod "$pod" --argjson restart_count "$restart_count" '{namespace:$namespace,pod:$pod,restart_count:$restart_count}')"
  done < <(
    kubectl --request-timeout="$KUBECTL_TIMEOUT" get pods -A -o json 2>/dev/null \
      | jq -r '.items[]? | [.metadata.namespace, .metadata.name, ([.status.containerStatuses[]?.restartCount // 0] | add // 0)] | @tsv' 2>/dev/null || true
  )
}

ciw_collect_hpa_scale() {
  command -v kubectl >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r ns name current desired min max; do
    [[ -n "$ns" && -n "$name" ]] || continue
    ciw_ns_allowed "$ns" || continue
    [[ "$current" =~ ^[0-9]+$ && "$desired" =~ ^[0-9]+$ ]] || continue
    (( current != desired )) || continue
    ciw_emit_change \
      "kubernetes" \
      "hpa_scale_delta" \
      "${ns}/${name}" \
      "$(ciw_now_utc)" \
      "info" \
      "HPA ${ns}/${name} current=${current} desired=${desired}" \
      "$(jq -nc --arg namespace "$ns" --arg name "$name" --argjson current "$current" --argjson desired "$desired" --argjson min "$min" --argjson max "$max" '{namespace:$namespace,name:$name,current:$current,desired:$desired,min:$min,max:$max}')"
  done < <(
    kubectl --request-timeout="$KUBECTL_TIMEOUT" get hpa -A -o json 2>/dev/null \
      | jq -r '.items[]? | [.metadata.namespace, .metadata.name, (.status.currentReplicas // 0), (.status.desiredReplicas // 0), (.spec.minReplicas // 0), (.spec.maxReplicas // 0)] | @tsv' 2>/dev/null || true
  )
}

ciw_collect_workload_images() {
  command -v kubectl >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r ns kind name created revision image; do
    [[ -n "$ns" && -n "$name" && -n "$image" ]] || continue
    ciw_ns_allowed "$ns" || continue
    if ! ciw_within_window "$created" && [[ -z "$revision" || "$revision" == "null" ]]; then
      continue
    fi
    ciw_emit_change \
      "kubernetes" \
      "image_change_visible" \
      "${ns}/${kind}/${name}" \
      "${created:-$(ciw_now_utc)}" \
      "info" \
      "${kind} ${ns}/${name} image=${image}" \
      "$(jq -nc --arg namespace "$ns" --arg kind "$kind" --arg name "$name" --arg image "$image" --arg revision "$revision" '{namespace:$namespace,kind:$kind,name:$name,image:$image,revision:$revision}')"
  done < <(
    kubectl --request-timeout="$KUBECTL_TIMEOUT" get deploy,statefulset -A -o json 2>/dev/null \
      | jq -r '.items[]? | [.metadata.namespace, .kind, .metadata.name, (.metadata.creationTimestamp // ""), (.metadata.annotations."deployment.kubernetes.io/revision" // ""), ([.spec.template.spec.containers[]?.image] | join(","))] | @tsv' 2>/dev/null || true
  )
}

ciw_collect_visible_config() {
  command -v kubectl >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r kind ns name created; do
    [[ -n "$ns" && -n "$name" ]] || continue
    ciw_ns_allowed "$ns" || continue
    ciw_within_window "$created" || continue
    ciw_emit_change \
      "kubernetes" \
      "${kind}_change_visible" \
      "${ns}/${name}" \
      "$created" \
      "info" \
      "${kind} ${ns}/${name} created within change window" \
      "$(jq -nc --arg kind "$kind" --arg namespace "$ns" --arg name "$name" '{kind:$kind,namespace:$namespace,name:$name}')"
  done < <(
    kubectl --request-timeout="$KUBECTL_TIMEOUT" get configmap,secret -A -o json 2>/dev/null \
      | jq -r '.items[]? | [.kind | ascii_downcase, .metadata.namespace, .metadata.name, (.metadata.creationTimestamp // "")] | @tsv' 2>/dev/null || true
  )
}

changes_in_window_collect_json() {
  CIW_TIMELINE_NDJSON=""
  CIW_EVIDENCE_NDJSON=""
  CIW_EVENT_COUNT=0

  ciw_collect_argocd
  ciw_collect_pod_restarts
  ciw_collect_hpa_scale
  ciw_collect_workload_images
  ciw_collect_visible_config

  local sorted_timeline summary_block
  sorted_timeline="$(printf '%s\n' "${CIW_TIMELINE_NDJSON:-}" | timeline_merge_sort_ndjson 2>/dev/null || true)"
  summary_block="$(timeline_summary_block "$sorted_timeline" 6 2>/dev/null || true)"

  jq -nc \
    --arg version "sre.changes-window.v1" \
    --arg generated_at "$(ciw_now_utc)" \
    --arg summary_block "$summary_block" \
    --arg timeline_ndjson "$sorted_timeline" \
    --arg evidence_ndjson "${CIW_EVIDENCE_NDJSON:-}" \
    --argjson event_count "${CIW_EVENT_COUNT:-0}" \
    --argjson window_minutes "${CHANGE_WINDOW_MINUTES:-180}" \
    '{
      version: $version,
      generated_at: $generated_at,
      window_minutes: $window_minutes,
      event_count: $event_count,
      summary_block: $summary_block,
      timeline_ndjson: $timeline_ndjson,
      evidence_ndjson: $evidence_ndjson
    }'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  changes_in_window_collect_json
fi
