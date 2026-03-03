#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL: %s\n' "$1" >&2
}

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip: jq missing\n'
  exit 0
fi

OVERLAY_DIR="$(mktemp -d)"
trap 'rm -rf "${OVERLAY_DIR}"' EXIT

cat >"${OVERLAY_DIR}/api-gateway.yaml" <<'YAML'
service: api-gateway
namespace: production
cluster: dev-morpho
tier: critical
team: platform
owners:
  primary: "@alice"
  escalation: "@platform-oncall"
known_failure_modes:
  - id: oom-under-load
    pattern: "OOMKilled + request_rate > 500/s"
    root_cause: "unbounded request body buffering"
    remediation: "scale to 4 replicas, then apply memory limit patch"
    rollback: "revert to previous image tag"
safe_operations:
  - "horizontal scale (2-6 replicas)"
  - "restart pods (rolling)"
unsafe_operations:
  - "delete PVC (data loss)"
resource_baseline:
  cpu_normal: "200m-400m"
  memory_normal: "256Mi-512Mi"
  memory_oom_threshold: "480Mi"
YAML

SERVICE_OVERLAY_DIR="$OVERLAY_DIR"
export SERVICE_OVERLAY_DIR
# shellcheck source=lib-service-overlay.sh
source "${SCRIPT_DIR}/lib-service-overlay.sh"

OVERLAY_JSON="$(load_service_overlay "dev-morpho" "production" "api-gateway")"
if [[ -n "$OVERLAY_JSON" ]] && printf '%s\n' "$OVERLAY_JSON" | jq -e '.service == "api-gateway"' >/dev/null 2>&1; then
  pass 'overlay loads for matching cluster/ns/service'
else
  fail 'overlay should load for matching service'
fi

MISSING="$(load_service_overlay "dev-morpho" "production" "nonexistent")"
if [[ -z "$MISSING" ]]; then
  pass 'missing overlay returns empty output'
else
  fail 'missing overlay should be empty'
fi

WRONG_CLUSTER="$(load_service_overlay "prod-morpho" "production" "api-gateway")"
if [[ -z "$WRONG_CLUSTER" ]]; then
  pass 'cluster mismatch returns empty output'
else
  fail 'cluster mismatch should be empty'
fi

MODES="$(printf '%s\n' "$OVERLAY_JSON" | extract_known_failure_modes)"
if printf '%s\n' "$MODES" | grep -q '^oom-under-load$'; then
  pass 'known failure mode ids extracted'
else
  fail 'known failure mode id missing'
fi

FORMATTED="$(printf '%s\n' "$OVERLAY_JSON" | format_overlay_context)"
if [[ "$FORMATTED" == *"Team: platform"* ]] && [[ "$FORMATTED" == *"Known failure modes"* ]]; then
  pass 'overlay context formatter returns text block'
else
  fail 'overlay context formatter missing expected content'
fi

printf '\nResults: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
