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

codex_rca_provider() {
  printf '{"severity":"high","canonical_category":"resource_exhaustion","summary":"oom","root_cause":"leak","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":81,"description":"oom","evidence_keys":[]}]}'
}
export -f codex_rca_provider

run_case() {
  local case_dir="$1"
  local fail_sink="${2:-}"

  local bin_dir="${case_dir}/bin"
  local lib_dir="${case_dir}/libs"
  mkdir -p "$bin_dir" "$lib_dir"

  cat >"${lib_dir}/lib-rca-sink.sh" <<'EOS'
#!/usr/bin/env bash
redact_for_sink() {
  local payload="$1"
  local sink="$2"
  printf '%s\n' "$sink" >>"${SINK_CALLS_FILE}"
  if [[ -n "${SINK_FAIL_ON:-}" && "${SINK_FAIL_ON}" == "$sink" ]]; then
    printf 'quarantine\n' >&2
    return 1
  fi
  printf '%s\n' "$payload"
}
EOS
  chmod +x "${lib_dir}/lib-rca-sink.sh"

  cat >"${bin_dir}/timeout" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
shift
"$@"
EOS

  cat >"${bin_dir}/kubectl" <<'EOS'
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

  cat >"${bin_dir}/curl" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo '{"status":"success","data":{"result":[]}}'
EOS

  cat >"${bin_dir}/aws" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo '{}'
EOS

  chmod +x "${bin_dir}/timeout" "${bin_dir}/kubectl" "${bin_dir}/curl" "${bin_dir}/aws"

  export SINK_CALLS_FILE="${case_dir}/sink-calls.log"
  : >"$SINK_CALLS_FILE"
  export SINK_FAIL_ON="$fail_sink"

  PATH="${bin_dir}:$PATH" \
  RCA_SCRIPT_DIR="$lib_dir" \
  INCLUDE_REPO_MAP=0 \
  INCLUDE_IMAGE_REVISION=0 \
  INCLUDE_CI_SIGNAL=0 \
  PROMETHEUS_URL="http://mock-prom" \
  ARGOCD_BASE_URL="http://mock-argocd" \
  INCIDENT_STATE_DIR="${case_dir}/state" \
  ACTIVE_INCIDENTS_FILE="${case_dir}/state/active-incidents.tsv" \
  RESOLVED_INCIDENTS_FILE="${case_dir}/state/resolved-incidents.tsv" \
  SPOOL_DIR="${case_dir}/state/spool" \
  bash "$TRIAGE_SCRIPT" >"${case_dir}/triage.out"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

run_case "${TMP_DIR}/ok" ""
for sink in slack linear webhook; do
  rg -q "^${sink}$" "${TMP_DIR}/ok/sink-calls.log" || fail "missing redact_for_sink call for ${sink}"
done
spool_file_ok="$(find "${TMP_DIR}/ok/state/spool" -maxdepth 1 -type f -name 'triage-*.json' | head -n1 || true)"
[[ -n "$spool_file_ok" ]] || fail "expected spool payload on clean redact path"
rg -q $'sink_quarantine_status\tnone' "${TMP_DIR}/ok/triage.out" || fail "sink quarantine status should be none"
pass "all sink paths invoke redact_for_sink"

run_case "${TMP_DIR}/quarantine" "linear"
spool_file_bad="$(find "${TMP_DIR}/quarantine/state/spool" -maxdepth 1 -type f -name 'triage-*.json' | head -n1 || true)"
[[ -z "$spool_file_bad" ]] || fail "quarantine path must suppress spool write"
rg -q $'sink_quarantine_status\tquarantined:linear' "${TMP_DIR}/quarantine/triage.out" || fail "expected quarantined status"
pass "fail-closed quarantine suppresses outbound sink"

printf 'all tests passed (%d)\n' "$PASS"
