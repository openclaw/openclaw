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
mkdir -p "$TMPBIN"

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
{"items":[{"metadata":{"namespace":"morpho-dev","name":"api-7b5f8c9d4-xk2lm"},"status":{"phase":"Running","containerStatuses":[{"name":"api","restartCount":4,"state":{"waiting":{"reason":"CrashLoopBackOff","message":"panic"}}}]}}]}
JSON
  exit 0
fi
if [[ "$args" == *"get deploy -A -o json"* || "$args" == *"get events -A -o json"* || "$args" == *"get ingress -A -o json"* || "$args" == *"get secret -A -o json"* ]]; then
  echo '{"items":[]}'
  exit 0
fi
if [[ "$args" == *"logs"* ]]; then
  echo "panic: startup failed"
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

codex_rca_provider() {
  printf '{"severity":"high","canonical_category":"resource_exhaustion","summary":"oom","root_cause":"leak","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":80,"description":"oom","evidence_keys":[]}]}'
}
export -f codex_rca_provider

OUT_FILE="${TMP_DIR}/triage.out"
PATH="${TMPBIN}:$PATH" \
INCLUDE_REPO_MAP=0 \
INCLUDE_IMAGE_REVISION=0 \
INCLUDE_CI_SIGNAL=0 \
PROMETHEUS_URL="http://mock-prom" \
ARGOCD_BASE_URL="http://mock-argocd" \
INCIDENT_STATE_DIR="${TMP_DIR}/state" \
ACTIVE_INCIDENTS_FILE="${TMP_DIR}/state/active-incidents.tsv" \
RESOLVED_INCIDENTS_FILE="${TMP_DIR}/state/resolved-incidents.tsv" \
SPOOL_DIR="${TMP_DIR}/state/spool" \
bash "$TRIAGE_SCRIPT" >"$OUT_FILE"

payload_file="$(find "${TMP_DIR}/state/spool" -maxdepth 1 -type f -name 'triage-*.json' | sort | tail -n1)"
[[ -n "$payload_file" && -s "$payload_file" ]] || fail "expected step11 payload spool file"
payload_json="$(cat "$payload_file")"
primary_from_payload="$(printf '%s\n' "$payload_json" | jq -r '.primary_category // empty')"
[[ -n "$primary_from_payload" ]] || fail "primary_category missing from structured payload"

LEGACY_CATEGORY_PARSER_HIT=0
EXTRACTED_CATEGORY=""
extract_primary_category() {
  local payload="$1"
  local fallback_text="$2"
  local structured
  structured="$(printf '%s\n' "$payload" | jq -r '.primary_category // empty' 2>/dev/null || true)"
  if [[ -n "$structured" ]]; then
    EXTRACTED_CATEGORY="$structured"
    return 0
  fi
  LEGACY_CATEGORY_PARSER_HIT=$((LEGACY_CATEGORY_PARSER_HIT + 1))
  EXTRACTED_CATEGORY="$fallback_text"
}

extract_primary_category "$payload_json" "legacy-fallback"
[[ "$EXTRACTED_CATEGORY" == "$primary_from_payload" ]] || fail "structured handoff should win"
[[ "$LEGACY_CATEGORY_PARSER_HIT" -eq 0 ]] || fail "legacy parser should not run when payload category exists"
pass "structured category handoff"

extract_primary_category '{"no_primary":true}' "legacy-fallback"
[[ "$EXTRACTED_CATEGORY" == "legacy-fallback" ]] || fail "fallback category expected"
[[ "$LEGACY_CATEGORY_PARSER_HIT" -eq 1 ]] || fail "fallback should increment warning metric"
pass "legacy fallback path increments metric"

printf 'all tests passed (%d)\n' "$PASS"
