#!/usr/bin/env bash
set -euo pipefail

ARGOCD_BASE_URL="${ARGOCD_BASE_URL:-}"
ARGOCD_AUTH_TOKEN="${ARGOCD_AUTH_TOKEN:-${ARGOCD_TOKEN:-}}"
SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev,monitoring}"
ARGOCD_TIMEOUT_SECONDS="${ARGOCD_TIMEOUT_SECONDS:-8}"
ARGOCD_SYNC_EVIDENCE_FILE="${ARGOCD_SYNC_EVIDENCE_FILE:-}"

if [[ -z "$ARGOCD_BASE_URL" ]]; then
  exit 0
fi

echo -e "app_name\tsync_status\thealth_status\tlast_sync_time\tlast_sync_result\tdrift_summary"

if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v date >/dev/null 2>&1; then
  echo -e "argocd-api\tunknown\tunknown\tn/a\tunknown\tmissing_dependency"
  exit 0
fi

if [[ -z "$ARGOCD_AUTH_TOKEN" ]]; then
  echo -e "argocd-api\tunknown\tunknown\tn/a\tunknown\tmissing_token"
  exit 0
fi

token_len="$(printf '%s' "$ARGOCD_AUTH_TOKEN" | wc -c | tr -d '[:space:]')"

epoch_from_iso() {
  local value="$1"
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo ""
    return
  fi
  date -u -d "$value" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$value" +%s 2>/dev/null || echo ""
}

append_drift_evidence() {
  local app_name="$1"
  local ns="$2"
  local drift_count="$3"
  local severity="$4"
  local last_sync_time="$5"
  [[ -n "$ARGOCD_SYNC_EVIDENCE_FILE" ]] || return 0
  [[ "$drift_count" =~ ^[0-9]+$ ]] || return 0
  (( drift_count > 0 )) || return 0

  jq -nc \
    --arg scope "${ns}/${app_name}" \
    --arg severity "$severity" \
    --arg app_name "$app_name" \
    --arg namespace "$ns" \
    --arg last_sync_time "$last_sync_time" \
    --argjson drift_count "$drift_count" \
    '{
      version: "sre.evidence-row.v1",
      source: "argocd-sync-status",
      kind: "argocd_drift",
      scope: $scope,
      observed_at: (now | todateiso8601),
      ttl_seconds: 900,
      stale_after: ((now + 900) | todateiso8601),
      confidence: 0.8,
      entity_ids: [],
      payload: {
        app_name: $app_name,
        namespace: $namespace,
        severity: $severity,
        drifted_resources: $drift_count,
        last_sync_time: $last_sync_time
      },
      collection_error: ""
    }' >>"$ARGOCD_SYNC_EVIDENCE_FILE"
}

now_epoch="$(date -u +%s)"
ns_filter="$(printf '%s' "$SCOPE_NAMESPACES" | tr ',' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | awk 'NF>0{print}')"

tmp_json="$(mktemp)"
http_code="$(curl -sS --max-time "$ARGOCD_TIMEOUT_SECONDS" -o "$tmp_json" -w '%{http_code}' \
  -H "Authorization: Bearer ${ARGOCD_AUTH_TOKEN}" \
  -H 'Accept: application/json' \
  "${ARGOCD_BASE_URL%/}/api/v1/applications" || true)"

if [[ "$http_code" != "200" ]]; then
  if [[ "$http_code" == "401" || "$http_code" == "403" ]]; then
    echo -e "argocd-api\tunknown\tunknown\tn/a\tunknown\tauth_http_${http_code};token_len=${token_len:-0}"
  else
    echo -e "argocd-api\tunknown\tunknown\tn/a\tunknown\thttp_${http_code:-error}"
  fi
  rm -f "$tmp_json"
  exit 0
fi

while IFS=$'\t' read -r app_name ns sync_status health_status last_sync_time last_sync_result drift_count; do
  [[ -z "$app_name" ]] && continue

  if [[ -n "$ns_filter" ]]; then
    if ! printf '%s\n' "$ns_filter" | grep -Fxq "$ns"; then
      continue
    fi
  fi

  sync_epoch="$(epoch_from_iso "$last_sync_time")"
  age_sec=""
  if [[ -n "$sync_epoch" ]]; then
    age_sec=$(( now_epoch - sync_epoch ))
    if (( age_sec < 0 )); then
      age_sec=0
    fi
  fi

  severity="ok"
  if [[ "$last_sync_result" == "Failed" ]] && [[ -n "$age_sec" ]] && (( age_sec <= 1800 )); then
    severity="critical"
  elif [[ "$sync_status" == "OutOfSync" ]] && [[ -n "$age_sec" ]] && (( age_sec > 3600 )); then
    severity="warning"
  elif [[ "$health_status" == "Degraded" || "$health_status" == "Missing" ]]; then
    severity="warning"
  fi

  drift_summary="drifted_resources=${drift_count};severity=${severity}"
  append_drift_evidence "$app_name" "$ns" "$drift_count" "$severity" "$last_sync_time"
  echo -e "${app_name}\t${sync_status}\t${health_status}\t${last_sync_time}\t${last_sync_result}\t${drift_summary}"
done < <(
  jq -r '
    .items[]?
    | .metadata.name as $app
    | (.spec.destination.namespace // "-") as $ns
    | (.status.sync.status // "Unknown") as $sync
    | (.status.health.status // "Unknown") as $health
    | (.status.operationState.finishedAt // .status.reconciledAt // "n/a") as $sync_time
    | (.status.operationState.phase // "Unknown") as $sync_result
    | ([.status.resources[]? | select((.status // "") != "Synced")] | length) as $drift
    | [$app, $ns, $sync, $health, $sync_time, $sync_result, ($drift|tostring)]
    | @tsv
  ' "$tmp_json" 2>/dev/null || true
)

rm -f "$tmp_json"
