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

SERVICE_CONTEXT_ENABLED=1
export SERVICE_CONTEXT_ENABLED
# shellcheck source=lib-service-context.sh
source "${SCRIPT_DIR}/lib-service-context.sh"

load_service_overlay() {
  local _cluster="$1"
  local _namespace="$2"
  local _service="$3"
  cat <<'JSON'
{"service":"api-gateway","namespace":"production","cluster":"dev-morpho","team":"platform","tier":"critical","owners":{"primary":"@alice","escalation":"@platform-oncall"},"known_failure_modes":[{"id":"oom-under-load","pattern":"OOMKilled + request_rate > 500/s","remediation":"scale to 4 replicas"}],"safe_operations":["horizontal scale (2-6 replicas)"],"unsafe_operations":["delete PVC (data loss)"],"resource_baseline":{"cpu_normal":"200m-400m","memory_normal":"256Mi-512Mi","memory_oom_threshold":"480Mi"}}
JSON
}

format_overlay_context() {
  jq -r '"Team: " + .team + " (" + .owners.primary + ", escalation: " + .owners.escalation + ")\nTier: " + .tier + "\nResource baseline: CPU " + .resource_baseline.cpu_normal + ", Memory " + .resource_baseline.memory_normal'
}

read_service_graph() {
  cat <<'JSON'
{"cluster":"dev-morpho","generated_at":"2026-03-03T14:30:00Z","discovery_tiers":["t1","t2"],"services":{"production/api-gateway":{"namespace":"production","team":"platform","tier":"critical","depends_on":[{"service":"production/auth-service","edge_type":"calls","discovery_tier":"t2"}],"depended_by":[{"service":"production/web-frontend","edge_type":"calls","discovery_tier":"t2"}]}}}
JSON
}

memory_lookup_broad() {
  local _cluster="$1"
  local _namespace="$2"
  local _service="$3"
  cat <<'JSON'
[{"date":"2026-02-15","category":"resource_exhaustion","severity":"high","root_cause_summary":"OOM from memory leak","fix_applied":"rollback","permanent_fix_pr":"#847"}]
JSON
}

format_memory_context() {
  jq -r '"Past incidents (last 90d):\n" + (map("  - " + .date + ": " + .root_cause_summary + " (fix: " + .permanent_fix_pr + ")") | join("\n"))'
}

OUT="$(assemble_service_context "dev-morpho" "production" "api-gateway")"

if [[ "$OUT" == *"=== SERVICE CONTEXT: api-gateway (production) ==="* ]]; then
  pass 'context header present'
else
  fail 'missing service context header'
fi

if [[ "$OUT" == *"Team: platform"* ]] && [[ "$OUT" == *"Tier: critical"* ]]; then
  pass 'overlay team/tier included'
else
  fail 'overlay team/tier missing'
fi

if [[ "$OUT" == *"Dependencies: production/auth-service (calls, t2)"* ]] && [[ "$OUT" == *"Depended by: production/web-frontend (calls, t2)"* ]]; then
  pass 'service graph dependencies included'
else
  fail 'service graph dependencies missing'
fi

if [[ "$OUT" == *"Past incidents (last 90d):"* ]] && [[ "$OUT" == *"OOM from memory leak"* ]]; then
  pass 'memory context included'
else
  fail 'memory context missing'
fi

if printf '%s\n' "$OUT" | jq -e . >/dev/null 2>&1; then
  fail 'output should be plain text, not JSON'
else
  pass 'output is plain text block'
fi

SERVICE_CONTEXT_ENABLED=0
OUT_DISABLED="$(assemble_service_context "dev-morpho" "production" "api-gateway")"
if [[ -z "$OUT_DISABLED" ]]; then
  pass 'feature flag disables context block'
else
  fail 'context should be empty when disabled'
fi

printf '\nResults: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
