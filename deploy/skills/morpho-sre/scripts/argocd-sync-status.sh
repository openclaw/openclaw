#!/usr/bin/env bash
set -euo pipefail

ARGOCD_BASE_URL="${ARGOCD_BASE_URL:-}"
ARGOCD_AUTH_TOKEN="${ARGOCD_AUTH_TOKEN:-${ARGOCD_TOKEN:-}}"
SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev,monitoring}"
ARGOCD_TIMEOUT_SECONDS="${ARGOCD_TIMEOUT_SECONDS:-8}"

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

epoch_from_iso() {
  local value="$1"
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo ""
    return
  fi
  date -u -d "$value" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$value" +%s 2>/dev/null || echo ""
}

now_epoch="$(date -u +%s)"
ns_filter="$(printf '%s' "$SCOPE_NAMESPACES" | tr ',' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | awk 'NF>0{print}')"

tmp_json="$(mktemp)"
http_code="$(curl -sS --max-time "$ARGOCD_TIMEOUT_SECONDS" -o "$tmp_json" -w '%{http_code}' \
  -H "Authorization: Bearer ${ARGOCD_AUTH_TOKEN}" \
  -H 'Accept: application/json' \
  "${ARGOCD_BASE_URL%/}/api/v1/applications" || true)"

if [[ "$http_code" != "200" ]]; then
  echo -e "argocd-api\tunknown\tunknown\tn/a\tunknown\thttp_${http_code:-error}"
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
