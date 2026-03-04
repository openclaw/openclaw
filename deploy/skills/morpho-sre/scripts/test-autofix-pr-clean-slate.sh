#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/autofix-pr.sh"

extract_function() {
  local fn="$1"
  sed -n "/^${fn}()[[:space:]]*{/,/^}/p" "$SCRIPT_PATH"
}

fail() {
  echo "FAIL: $*"
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN_DIR="${TMP_DIR}/bin"
CALLS_FILE="${TMP_DIR}/git-calls.log"
mkdir -p "$TMP_BIN_DIR"

cat > "${TMP_BIN_DIR}/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${CALLS_FILE:?}"

if printf '%s' "$*" | grep -q 'fetch origin '; then
  if [[ "${FAIL_FETCH:-0}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

if printf '%s' "$*" | grep -q 'rev-list --count '; then
  printf '%s\n' "${PREEXISTING_COUNT:-0}"
  exit 0
fi

exit 0
SH
chmod +x "${TMP_BIN_DIR}/git"
PATH="${TMP_BIN_DIR}:$PATH"
export CALLS_FILE

# only needed for extracted function dependency safety
require_cmd() {
  :
}

eval "$(extract_function assert_clean_slate_before_branch)"

export PREEXISTING_COUNT=0
assert_clean_slate_before_branch "/tmp/repo" "main" "token123" || fail "expected clean-slate check success when head has no extra commits"
if ! grep -q "fetch origin main" "$CALLS_FILE"; then
  fail "expected fetch origin main call"
fi
if ! grep -q "http.extraHeader=Authorization: Basic token123" "$CALLS_FILE"; then
  fail "expected auth header on fetch call"
fi
echo "PASS: clean-slate check passes when head has no extra commits"

export PREEXISTING_COUNT=2
if assert_clean_slate_before_branch "/tmp/repo" "main" "token123" >/dev/null 2>&1; then
  fail "expected clean-slate check to fail when preexisting commits are present"
fi
echo "PASS: clean-slate check blocks when repository is ahead of base"

if assert_clean_slate_before_branch "/tmp/repo" "" "token123" >/dev/null 2>&1; then
  fail "expected missing base branch to fail"
fi
echo "PASS: clean-slate check validates required args"

export FAIL_FETCH=1
export PREEXISTING_COUNT=0
if assert_clean_slate_before_branch "/tmp/repo" "main" "token123" >/dev/null 2>&1; then
  fail "expected clean-slate check to fail when fetch fails"
fi
echo "PASS: clean-slate check fails when base fetch fails"

echo "All autofix-pr clean-slate tests passed."
