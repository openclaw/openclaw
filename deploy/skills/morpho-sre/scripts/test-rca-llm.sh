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

claude_rca_provider() {
  printf '{"severity":"high","canonical_category":"dependency","summary":"claude path","hypotheses":[{"canonical_category":"dependency","hypothesis_id":"dependency:upstream-timeout","confidence":78,"description":"upstream timeout","evidence_keys":["step03:timeouts"]}]}'
}

OUT_OK="$(run_step_11 'evidence line' single incident)"
MODE_OK="$(printf '%s\n' "$OUT_OK" | jq -r '.mode')"
CAT_OK="$(printf '%s\n' "$OUT_OK" | jq -r '.canonical_category')"
[[ "$MODE_OK" == "single" ]] || fail "mode should be single"
[[ "$CAT_OK" == "resource_exhaustion" ]] || fail "category should parse"
pass "mock codex response"

CLAUDE_OUT="$(call_claude_rca 'prompt')"
CLAUDE_CAT="$(printf '%s\n' "$CLAUDE_OUT" | jq -r '.canonical_category')"
[[ "$CLAUDE_CAT" == "dependency" ]] || fail "claude provider should be wired"
pass "mock claude response"

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
unset -f claude_rca_provider
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

cat >"${TMP_DIR}/capture-chain-mode.sh" <<'PROV'
#!/usr/bin/env bash
printf '%s\n' "$1" >"$2"
printf '{"mode":"chain_v2","canonical_category":"resource_exhaustion","summary":"chain dual","root_cause":"x","hypotheses":[{"hypothesis_id":"resource_exhaustion:other","canonical_category":"resource_exhaustion","confidence":81,"description":"x","evidence_keys":["e1"]}]}\n'
PROV
chmod +x "${TMP_DIR}/capture-chain-mode.sh"
run_rca_chain() {
  "${TMP_DIR}/capture-chain-mode.sh" "$5" "${TMP_DIR}/chain-mode.txt"
}
RCA_CHAIN_ENABLED=1
CHAIN_OUT="$(run_step_11 'evidence line' dual incident)"
CHAIN_MODE_CAPTURED="$(cat "${TMP_DIR}/chain-mode.txt")"
CHAIN_MODE_OUT="$(printf '%s\n' "$CHAIN_OUT" | jq -r '.mode')"
[[ "$CHAIN_MODE_CAPTURED" == "dual" ]] || fail "chain mode should forward dual"
[[ "$CHAIN_MODE_OUT" == "chain_v2" ]] || fail "chain output should pass through"
pass "chain dual mode forwarded"
RCA_CHAIN_ENABLED=0
unset -f run_rca_chain

OUT_SKIP="$(run_step_11 'evidence line' single healthy)"
STATUS_SKIP="$(printf '%s\n' "$OUT_SKIP" | jq -r '.status')"
[[ "$STATUS_SKIP" == "skipped" ]] || fail "healthy should skip"
pass "healthy skip"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
