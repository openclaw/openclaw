#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-service-graph.sh
source "${SCRIPT_DIR}/lib-service-graph.sh"

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

kubectl() {
  case "$*" in
    *"get deployments"*)
      cat <<'JSON_DEPLOYS'
{"items":[{"metadata":{"name":"api-gateway","namespace":"production","labels":{"app":"api-gateway","team":"platform","tier":"critical"}},"spec":{"template":{"spec":{"containers":[{"env":[{"name":"AUTH_SERVICE_URL","value":"http://auth-service.production.svc:8080"},{"name":"REDIS_HOST","value":"redis-cache.production.svc"}]}]}}}},{"metadata":{"name":"auth-service","namespace":"production","labels":{"app":"auth-service","team":"platform","tier":"critical"}},"spec":{"template":{"spec":{"containers":[{"env":[]}],"volumes":[{"configMap":{"name":"shared-config"}}]}}}}]}
JSON_DEPLOYS
      ;;
    *"get services"*)
      cat <<'JSON_SERVICES'
{"items":[{"metadata":{"name":"api-gateway","namespace":"production"},"spec":{"selector":{"app":"api-gateway"}}},{"metadata":{"name":"auth-service","namespace":"production"},"spec":{"selector":{"app":"auth-service"}}}]}
JSON_SERVICES
      ;;
    *)
      printf '{"items":[]}\n'
      ;;
  esac
}
export -f kubectl

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
SERVICE_GRAPH_FILE="${TMP_DIR}/service-graph.json"
SERVICE_GRAPH_LOCK="${TMP_DIR}/service-graph.lock"
export SERVICE_GRAPH_FILE SERVICE_GRAPH_LOCK

OUTPUT="$(SERVICE_GRAPH_TIERS='t1' K8S_CONTEXT='dev-morpho' discover_service_graph production)"

if printf '%s\n' "$OUTPUT" | jq -e '.services["production/api-gateway"]' >/dev/null 2>&1; then
  pass 'T1 discovery outputs service map'
else
  fail 'missing production/api-gateway'
fi

if printf '%s\n' "$OUTPUT" | jq -e '.services["production/api-gateway"].depends_on[] | select(.service=="production/auth-service")' >/dev/null 2>&1; then
  pass 'env-var dependency to auth-service'
else
  fail 'env-var dependency missing'
fi

if printf '%s\n' "$OUTPUT" | jq -e '.services | keys | all(test("/"))' >/dev/null 2>&1; then
  pass 'service keys fully qualified'
else
  fail 'service keys not fully qualified'
fi

if printf '%s\n' "$OUTPUT" | jq -e '.discovery_tiers | index("t1") != null' >/dev/null 2>&1; then
  pass 'discovery_tiers contains t1'
else
  fail 'discovery_tiers missing t1'
fi

if printf '%s\n' "$OUTPUT" | jq -e '.services["production/api-gateway"].team == "platform" and .services["production/api-gateway"].tier == "critical"' >/dev/null 2>&1; then
  pass 'team/tier extracted'
else
  fail 'team/tier extraction failed'
fi

if printf '%s\n' "$OUTPUT" | jq -e '.services["production/auth-service"].depended_by[] | select(.service=="production/api-gateway")' >/dev/null 2>&1; then
  pass 'reverse edges computed'
else
  fail 'reverse edge missing'
fi

REL_KNOWLEDGE_RUN_COUNT_FILE="${TMP_DIR}/relationship-builder-runs"
REL_KNOWLEDGE_BUILDER="${TMP_DIR}/relationship-knowledge-build.sh"
cat >"$REL_KNOWLEDGE_BUILDER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
run_count_file="${RELATIONSHIP_TEST_RUN_COUNT_FILE:?}"
out_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) out_dir="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -z "$out_dir" ]]; then
  echo "missing --output-dir" >&2
  exit 1
fi
mkdir -p "$out_dir"
run_count=0
if [[ -s "$run_count_file" ]]; then
  run_count="$(cat "$run_count_file")"
fi
run_count=$((run_count + 1))
printf '%s\n' "$run_count" >"$run_count_file"
cat >"${out_dir}/initial-knowledge.v1.json" <<'JSON'
{"relationships":[{"from":"production/api-gateway","to":"production/auth-service"}],"version":"test-v1"}
JSON
EOF
chmod +x "$REL_KNOWLEDGE_BUILDER"
export RELATIONSHIP_TEST_RUN_COUNT_FILE="$REL_KNOWLEDGE_RUN_COUNT_FILE"
REL_KNOWLEDGE_CACHE_FILE="${TMP_DIR}/relationship-knowledge-cache.json"

REL_OUTPUT_1="$(SERVICE_GRAPH_TIERS='t1' K8S_CONTEXT='dev-morpho' RELATIONSHIP_KNOWLEDGE_BUILDER="$REL_KNOWLEDGE_BUILDER" RELATIONSHIP_KNOWLEDGE_CACHE_FILE="$REL_KNOWLEDGE_CACHE_FILE" RELATIONSHIP_KNOWLEDGE_CACHE_TTL_SECONDS=300 discover_service_graph production)"
if printf '%s\n' "$REL_OUTPUT_1" | jq -e '.relationship_knowledge_summary.cache_hit == false and .relationship_knowledge_summary.payload.relationship_count == 1' >/dev/null 2>&1; then
  pass 'relationship metadata added on successful builder run'
else
  fail 'relationship metadata missing after successful builder run'
fi

REL_OUTPUT_2="$(SERVICE_GRAPH_TIERS='t1' K8S_CONTEXT='dev-morpho' RELATIONSHIP_KNOWLEDGE_BUILDER="$REL_KNOWLEDGE_BUILDER" RELATIONSHIP_KNOWLEDGE_CACHE_FILE="$REL_KNOWLEDGE_CACHE_FILE" RELATIONSHIP_KNOWLEDGE_CACHE_TTL_SECONDS=300 discover_service_graph production)"
if printf '%s\n' "$REL_OUTPUT_2" | jq -e '.relationship_knowledge_summary.cache_hit == true' >/dev/null 2>&1; then
  pass 'relationship metadata served from cache when fresh'
else
  fail 'relationship cache hit not reported'
fi

REL_BUILDER_RUN_COUNT="$(cat "$REL_KNOWLEDGE_RUN_COUNT_FILE" 2>/dev/null || printf '0')"
if [[ "$REL_BUILDER_RUN_COUNT" == "1" ]]; then
  pass 'relationship builder avoided re-run via cache'
else
  fail "relationship builder reran unexpectedly ($REL_BUILDER_RUN_COUNT)"
fi

REL_BAD_BUILDER="${TMP_DIR}/relationship-knowledge-build-invalid.sh"
cat >"$REL_BAD_BUILDER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) out_dir="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$out_dir"
printf 'not-json\n' >"${out_dir}/initial-knowledge.v1.json"
EOF
chmod +x "$REL_BAD_BUILDER"

REL_OUTPUT_FAIL="$(SERVICE_GRAPH_TIERS='t1' K8S_CONTEXT='dev-morpho' RELATIONSHIP_KNOWLEDGE_BUILDER="$REL_BAD_BUILDER" RELATIONSHIP_KNOWLEDGE_CACHE_FILE="${TMP_DIR}/relationship-knowledge-invalid-cache.json" RELATIONSHIP_KNOWLEDGE_CACHE_TTL_SECONDS=0 discover_service_graph production)"
if printf '%s\n' "$REL_OUTPUT_FAIL" | jq -e '.relationship_knowledge_summary == null' >/dev/null 2>&1; then
  pass 'invalid relationship builder output does not alter graph schema'
else
  fail 'invalid relationship builder output should not add summary'
fi

if printf '%s\n' "$REL_OUTPUT_FAIL" | jq -e '.services["production/api-gateway"]' >/dev/null 2>&1; then
  pass 'invalid relationship builder output falls back to base graph'
else
  fail 'base graph missing when relationship builder fails'
fi

write_service_graph "$OUTPUT"
if [[ -s "$SERVICE_GRAPH_FILE" ]]; then
  pass 'graph persisted via write_service_graph'
else
  fail 'graph not persisted'
fi

READ_BACK="$(read_service_graph)"
if printf '%s\n' "$READ_BACK" | jq -e '.services["production/api-gateway"]' >/dev/null 2>&1; then
  pass 'read_service_graph returns cached graph'
else
  fail 'read_service_graph failed'
fi

printf '\nResults: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
