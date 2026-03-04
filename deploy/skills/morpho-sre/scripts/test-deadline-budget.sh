#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE_SCRIPT="${SCRIPT_DIR}/sentinel-triage.sh"

PASS=0
pass() {
  PASS=$((PASS + 1))
  printf 'ok %d - %s\n' "$PASS" "$1"
}
fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip - jq missing\n'
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMPBIN="${TMP_DIR}/bin"
LIBDIR="${TMP_DIR}/libs"
mkdir -p "$TMPBIN" "$LIBDIR"

cat >"${LIBDIR}/lib-rca-chain.sh" <<'EOS'
#!/usr/bin/env bash
run_rca_chain() {
  cat <<'JSON'
{"mode":"chain_v2_partial","severity":"high","canonical_category":"resource_exhaustion","summary":"partial chain result","root_cause":"deadline budget preserved","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":70,"description":"partial","evidence_keys":[]}],"degradation_note":"partial due budget"}
JSON
}
EOS
chmod +x "${LIBDIR}/lib-rca-chain.sh"

cat >"${TMPBIN}/timeout" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
shift
"$@"
EOS

cat >"${TMPBIN}/kubectl" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
sleep 0.2
args="$*"
if [[ "$args" == *"config current-context"* ]]; then
  echo "mock-context"
  exit 0
fi
if [[ "$args" == *"get pods -A -o json"* ]]; then
  cat <<'JSON'
{"items":[{"metadata":{"namespace":"morpho-dev","name":"api-7b5f8c9d4-xk2lm"},"status":{"phase":"Running","containerStatuses":[{"name":"api","restartCount":7,"state":{"waiting":{"reason":"CrashLoopBackOff","message":"panic"}}}]}}]}
JSON
  exit 0
fi
if [[ "$args" == *"get deploy -A -o json"* || "$args" == *"get events -A -o json"* || "$args" == *"get ingress -A -o json"* || "$args" == *"get secret -A -o json"* ]]; then
  echo '{"items":[]}'
  exit 0
fi
if [[ "$args" == *"logs"* ]]; then
  echo "panic"
  exit 0
fi
echo '{"items":[]}'
EOS

cat >"${TMPBIN}/curl" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
sleep 0.2
echo '{"status":"success","data":{"result":[]}}'
EOS

cat >"${TMPBIN}/aws" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
sleep 0.2
echo '{}'
EOS

chmod +x "${TMPBIN}/timeout" "${TMPBIN}/kubectl" "${TMPBIN}/curl" "${TMPBIN}/aws"

start_ts="$(date +%s)"
OUT_FILE="${TMP_DIR}/triage.out"
PATH="${TMPBIN}:$PATH" \
RCA_SCRIPT_DIR="$LIBDIR" \
RCA_CHAIN_ENABLED=1 \
INCLUDE_REPO_MAP=0 \
INCLUDE_IMAGE_REVISION=0 \
INCLUDE_CI_SIGNAL=0 \
PROMETHEUS_URL="http://mock-prom" \
ARGOCD_BASE_URL="http://mock-argocd" \
STEP_TIMEOUT_POD_DEPLOY_SECONDS=1 \
STEP_TIMEOUT_EVENTS_ALERTS_SECONDS=1 \
STEP_TIMEOUT_LINEAR_MEMORY_SECONDS=1 \
STEP_TIMEOUT_PROMETHEUS_TRENDS_SECONDS=1 \
STEP_TIMEOUT_ARGOCD_SYNC_SECONDS=1 \
STEP_TIMEOUT_LOG_SIGNALS_SECONDS=1 \
STEP_TIMEOUT_CERT_SECRET_HEALTH_SECONDS=1 \
STEP_TIMEOUT_AWS_RESOURCE_SIGNALS_SECONDS=1 \
STEP_TIMEOUT_IMAGE_REPO_SECONDS=1 \
STEP_TIMEOUT_REVISIONS_SECONDS=1 \
STEP_TIMEOUT_CI_SIGNALS_SECONDS=1 \
INCIDENT_STATE_DIR="${TMP_DIR}/state" \
ACTIVE_INCIDENTS_FILE="${TMP_DIR}/state/active-incidents.tsv" \
RESOLVED_INCIDENTS_FILE="${TMP_DIR}/state/resolved-incidents.tsv" \
SPOOL_DIR="${TMP_DIR}/state/spool" \
bash "$TRIAGE_SCRIPT" >"$OUT_FILE"
end_ts="$(date +%s)"
elapsed="$((end_ts - start_ts))"

[[ "$elapsed" -lt 240 ]] || fail "run exceeded 240s budget (${elapsed}s)"
pass "run stays under 240s deadline"

json_line="$(rg '^\{' "$OUT_FILE" | tail -n1)"
[[ -n "$json_line" ]] || fail "missing RCA JSON output"
mode="$(printf '%s\n' "$json_line" | jq -r '.mode // empty')"
[[ "$mode" == "chain_v2_partial" ]] || fail "expected chain_v2_partial, got '$mode'"
pass "partial result returned"

printf '%s\n' "$json_line" | jq -e '.summary and .root_cause and (.hypotheses | type == "array")' >/dev/null || fail "RCA JSON schema missing required fields"
pass "partial JSON schema valid"

printf 'all tests passed (%d)\n' "$PASS"
