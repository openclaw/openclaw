#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=linear-memory-lookup.sh
source "${SCRIPT_DIR}/linear-memory-lookup.sh"

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
  local haystack="$1"
  local needle="$2"
  local msg="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$msg"
}

linear_memory_provider() {
  local _query="$1"
  local _limit="$2"
  printf 'PLA-101\tIncident redis pool exhausted\tRollback and pool tune\t3\n'
  printf 'PLA-099\tIncident config drift\tArgo sync restored\t11\n'
}

LINEAR_AVAILABLE=true
OUT_OK="$(linear_memory_lookup "redis" 5)"
FIRST_LINE="$(printf '%s\n' "$OUT_OK" | head -n1)"
assert_contains "$FIRST_LINE" $'status\tok\t2' "status/count line"
assert_contains "$OUT_OK" $'ticket_id\ttitle\tresolution_context\tdays_ago' "header row"
assert_contains "$OUT_OK" "PLA-101" "result row present"
pass "output format"

LINEAR_AVAILABLE=false
OUT_SKIP="$(linear_memory_lookup "redis" 5)"
assert_contains "$OUT_SKIP" $'status\tskipped\tlinear_unavailable' "skip when linear unavailable"
pass "graceful skip when linear unavailable"

unset -f linear_memory_provider
LINEAR_AVAILABLE=true
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
cat > "${TMP_DIR}/slow-provider.sh" <<'PROV'
#!/usr/bin/env bash
sleep 2
printf 'PLA-1\tt\tc\t1\n'
PROV
chmod +x "${TMP_DIR}/slow-provider.sh"
LINEAR_MEMORY_PROVIDER_SCRIPT="${TMP_DIR}/slow-provider.sh"
LINEAR_MEMORY_TIMEOUT_SECONDS=1
OUT_TIMEOUT="$(linear_memory_lookup "redis" 5)"
if command -v timeout >/dev/null 2>&1; then
  assert_contains "$OUT_TIMEOUT" $'status\tskipped\ttimeout' "timeout should skip"
else
  assert_contains "$OUT_TIMEOUT" $'status\tok\t1' "no-timeout fallback should still work"
fi
pass "timeout/skip behavior"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
