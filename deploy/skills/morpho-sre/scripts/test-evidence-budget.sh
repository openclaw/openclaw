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
{"mode":"chain_v2","severity":"high","canonical_category":"resource_exhaustion","summary":"chain ok","root_cause":"budgeted evidence path","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":77,"description":"chain hypothesis","evidence_keys":["step01:pods"]}]}
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
args="$*"
if [[ "$args" == *"config current-context"* ]]; then
  echo "mock-context"
  exit 0
fi
if [[ "$args" == *"get pods -A -o json"* ]]; then
  cat <<'JSON'
{"items":[{"metadata":{"namespace":"morpho-dev","name":"api-7b5f8c9d4-xk2lm"},"status":{"phase":"Running","containerStatuses":[{"name":"api","restartCount":5,"state":{"waiting":{"reason":"CrashLoopBackOff","message":"panic"}}}]}}]}
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
echo '{"status":"success","data":{"result":[]}}'
EOS

cat >"${TMPBIN}/aws" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo '{}'
EOS

chmod +x "${TMPBIN}/timeout" "${TMPBIN}/kubectl" "${TMPBIN}/curl" "${TMPBIN}/aws"

cat >"${TMP_DIR}/slow-linear-provider.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
sleep 0.05
printf 'INC-1\ttitle\tresolution\t1\n'
EOS
chmod +x "${TMP_DIR}/slow-linear-provider.sh"

OUT_FILE="${TMP_DIR}/triage.out"
PATH="${TMPBIN}:$PATH" \
RCA_SCRIPT_DIR="$LIBDIR" \
RCA_CHAIN_ENABLED=1 \
RCA_EVIDENCE_TOTAL_TIMEOUT_MS=1 \
LINEAR_MEMORY_PROVIDER_SCRIPT="${TMP_DIR}/slow-linear-provider.sh" \
PROMETHEUS_URL="http://mock-prom" \
ARGOCD_BASE_URL="http://mock-argocd" \
INCIDENT_STATE_DIR="${TMP_DIR}/state" \
ACTIVE_INCIDENTS_FILE="${TMP_DIR}/state/active-incidents.tsv" \
RESOLVED_INCIDENTS_FILE="${TMP_DIR}/state/resolved-incidents.tsv" \
SPOOL_DIR="${TMP_DIR}/state/spool" \
bash "$TRIAGE_SCRIPT" >"$OUT_FILE"

awk -F $'\t' '$1 ~ /^(03|04|05|06|07)$/ && $2 == "skipped" { found=1 } END { exit(found ? 0 : 1) }' "$OUT_FILE" \
  || fail "expected optional evidence steps to be skipped after evidence budget exhaustion"
pass "evidence budget skips optional steps"

json_line="$(rg '^\{' "$OUT_FILE" | tail -n1)"
[[ -n "$json_line" ]] || fail "missing RCA JSON"
mode="$(printf '%s\n' "$json_line" | jq -r '.mode // empty')"
[[ "$mode" == "chain_v2" ]] || fail "expected chain mode execution"
pass "chain executes after evidence budget skip"

printf '%s\n' "$json_line" | jq -e '.severity and .canonical_category and .summary and (.hypotheses | type == "array")' >/dev/null || fail "schema-invalid RCA JSON"
pass "output JSON schema remains valid"

printf 'all tests passed (%d)\n' "$PASS"
