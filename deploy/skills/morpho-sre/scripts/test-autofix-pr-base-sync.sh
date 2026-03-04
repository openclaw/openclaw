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

cat > "${TMP_BIN_DIR}/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${CALLS_FILE:?}"
if [[ "${FAIL_REBASE:-0}" == "1" && "$*" == *" rebase "* ]]; then
  exit 1
fi
exit 0
EOF
chmod +x "${TMP_BIN_DIR}/git"
PATH="${TMP_BIN_DIR}:$PATH"
export CALLS_FILE

eval "$(extract_function sync_branch_with_base)"

sync_branch_with_base "/tmp/repo" "main" "token123" || fail "expected sync success"

if ! grep -q "fetch origin main" "$CALLS_FILE"; then
  fail "expected git fetch origin main call"
fi
if ! grep -q "rebase origin/main" "$CALLS_FILE"; then
  fail "expected git rebase origin/main call"
fi
if ! grep -q "http.extraHeader=Authorization: Basic token123" "$CALLS_FILE"; then
  fail "expected auth header on fetch call"
fi
echo "PASS: sync fetches + rebases onto latest base"

export FAIL_REBASE=1
if sync_branch_with_base "/tmp/repo" "main" "token123" >/dev/null 2>&1; then
  fail "expected sync failure when rebase fails"
fi
echo "PASS: sync reports failure on rebase conflict/error"

if sync_branch_with_base "/tmp/repo" "" "token123" >/dev/null 2>&1; then
  fail "expected sync failure with missing base branch"
fi
echo "PASS: sync validates required args"

echo "All autofix-pr base sync tests passed."
