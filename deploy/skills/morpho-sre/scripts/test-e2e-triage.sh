#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE_SCRIPT="${SCRIPT_DIR}/sentinel-triage.sh"

PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  local msg="$3"
  rg -q -- "$pattern" "$file" || fail "$msg (missing pattern: $pattern)"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TMPBIN="${TMP_DIR}/bin"
mkdir -p "$TMPBIN"

cat >"${TMPBIN}/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -lt 2 ]]; then
  exit 2
fi
shift
"$@"
EOF

cat >"${TMPBIN}/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args="$*"

if [[ "$args" == *"config current-context"* ]]; then
  echo "mock-context"
  exit 0
fi

if [[ "$args" == *"get pods -A -o json"* ]]; then
  cat <<'JSON'
{"items":[{"metadata":{"namespace":"morpho-dev","name":"api-7b5f8c9d4-xk2lm"},"status":{"phase":"Running","containerStatuses":[{"name":"api","restartCount":6,"state":{"waiting":{"reason":"CrashLoopBackOff","message":"Back-off restarting failed container"}}}]}}]}
JSON
  exit 0
fi

if [[ "$args" == *"get deploy -A -o json"* ]]; then
  echo '{"items":[]}'
  exit 0
fi

if [[ "$args" == *"get events -A -o json"* ]]; then
  echo '{"items":[]}'
  exit 0
fi

if [[ "$args" == *"get ingress -A -o json"* ]]; then
  echo '{"items":[]}'
  exit 0
fi

if [[ "$args" == *"get secret -A -o json"* ]]; then
  echo '{"items":[]}'
  exit 0
fi

if [[ "$args" == *"logs"* ]]; then
  echo "panic: startup failed"
  exit 0
fi

echo '{"items":[]}'
EOF

cat >"${TMPBIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${@: -1}"

if [[ "$url" == *"/api/v1/alerts"* ]]; then
  echo '{"status":"success","data":{"alerts":[]}}'
  exit 0
fi

if [[ "$url" == *"/api/v1/status/buildinfo"* ]]; then
  echo '{"status":"success","data":{"version":"mock"}}'
  exit 0
fi

if [[ "$url" == *"/api/v1/query"* ]]; then
  echo '{"status":"success","data":{"result":[]}}'
  exit 0
fi

if [[ "$url" == *"/api/v1/applications"* ]]; then
  echo '{"items":[]}'
  exit 0
fi

echo '{}'
EOF

cat >"${TMPBIN}/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"sts get-caller-identity"* ]]; then
  echo '{"Account":"123456789012"}'
  exit 0
fi
if [[ "$*" == *"ce get-cost-and-usage"* ]]; then
  echo '{"ResultsByTime":[{"Total":{"UnblendedCost":{"Amount":"1.23"}},"Groups":[]}]}'
  exit 0
fi
echo '{}'
EOF

chmod +x "${TMPBIN}/timeout" "${TMPBIN}/kubectl" "${TMPBIN}/curl" "${TMPBIN}/aws"

OUT_FILE="${TMP_DIR}/triage.out"
PATH="${TMPBIN}:$PATH" \
RCA_SCRIPT_DIR="${SCRIPT_DIR}" \
PROMETHEUS_URL="http://mock-prom" \
ARGOCD_BASE_URL="http://mock-argocd" \
INCIDENT_STATE_DIR="${TMP_DIR}/state" \
ACTIVE_INCIDENTS_FILE="${TMP_DIR}/state/active-incidents.tsv" \
RESOLVED_INCIDENTS_FILE="${TMP_DIR}/state/resolved-incidents.tsv" \
bash "$TRIAGE_SCRIPT" >"$OUT_FILE"

assert_contains "$OUT_FILE" '^=== step_status ===$' "step status section exists"
assert_contains "$OUT_FILE" $'^00\t' "step 00 status present"
assert_contains "$OUT_FILE" $'^03\t' "step 03 status present"
assert_contains "$OUT_FILE" $'^04\t' "step 04 status present"
assert_contains "$OUT_FILE" $'^06\t' "step 06 status present"
assert_contains "$OUT_FILE" $'^07\t' "step 07 status present"
assert_contains "$OUT_FILE" $'^11\t' "step 11 status present"
pass "all expected step statuses present"

assert_contains "$OUT_FILE" '^=== linear_incident_memory ===$' "linear memory section"
assert_contains "$OUT_FILE" '^=== prometheus_trends ===$' "prometheus section"
assert_contains "$OUT_FILE" '^=== argocd_sync ===$' "argocd section"
assert_contains "$OUT_FILE" '^=== cert_secret_health ===$' "cert section"
assert_contains "$OUT_FILE" '^=== aws_resource_signals ===$' "aws section"
assert_contains "$OUT_FILE" '^=== rca_result ===$' "rca section"
assert_contains "$OUT_FILE" '^=== triage_metrics ===$' "triage metrics section"
assert_contains "$OUT_FILE" '^=== meta_alerts ===$' "meta alerts section"
pass "deep-signal output sections present"

assert_contains "$OUT_FILE" $'^state\tincident$' "incident state detected"
assert_contains "$OUT_FILE" $'^incident_id\t' "incident id emitted"
assert_contains "$OUT_FILE" $'^evidence_completeness_pct\t' "completeness metric emitted"
pass "incident + metrics fields present"

printf 'all tests passed (%d)\n' "$PASS_COUNT"

