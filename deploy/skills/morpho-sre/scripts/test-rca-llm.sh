#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-rca-llm.sh
source "${SCRIPT_DIR}/lib-rca-llm.sh"

PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
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
  printf '{"severity":"high","canonical_category":"resource_exhaustion","summary":"pool issue","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":80,"description":"x","evidence_keys":["step01:oom"]}]}'
}

OUT_OK="$(run_step_11 'evidence line' single incident)"
MODE_OK="$(printf '%s\n' "$OUT_OK" | jq -r '.mode')"
CAT_OK="$(printf '%s\n' "$OUT_OK" | jq -r '.canonical_category')"
[[ "$MODE_OK" == "single" ]] || fail "mode should be single"
[[ "$CAT_OK" == "resource_exhaustion" ]] || fail "category should parse"
pass "mock codex response"

codex_rca_provider() {
  return 2
}
OUT_ERR="$(run_step_11 'evidence line' single incident)"
MODE_ERR="$(printf '%s\n' "$OUT_ERR" | jq -r '.mode')"
NOTE_ERR="$(printf '%s\n' "$OUT_ERR" | jq -r '.degradation_note')"
[[ "$MODE_ERR" == "single" ]] || fail "mode kept on fallback"
[[ "$NOTE_ERR" == *"heuristic fallback"* ]] || fail "fallback note"
pass "api error fallback"

unset -f codex_rca_provider
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
cat >"${TMP_DIR}/slow-codex.sh" <<'PROV'
#!/usr/bin/env bash
sleep 2
printf '{"severity":"high","canonical_category":"resource_exhaustion","hypotheses":[]}'
PROV
chmod +x "${TMP_DIR}/slow-codex.sh"
RCA_CODEX_PROVIDER_SCRIPT="${TMP_DIR}/slow-codex.sh"
RCA_LLM_TIMEOUT_MS=500
OUT_TIMEOUT="$(run_step_11 'evidence line' single incident)"
if command -v timeout >/dev/null 2>&1; then
  NOTE_TIMEOUT="$(printf '%s\n' "$OUT_TIMEOUT" | jq -r '.degradation_note')"
  [[ "$NOTE_TIMEOUT" == *"heuristic fallback"* ]] || fail "timeout fallback note"
fi
pass "timeout fallback"

OUT_SKIP="$(run_step_11 'evidence line' single healthy)"
STATUS_SKIP="$(printf '%s\n' "$OUT_SKIP" | jq -r '.status')"
[[ "$STATUS_SKIP" == "skipped" ]] || fail "healthy should skip"
pass "healthy skip"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
