#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/repo-clone.sh"

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

if [[ "$*" == *" symbolic-ref --quiet --short refs/remotes/origin/HEAD"* ]]; then
  if [[ -n "${MOCK_ORIGIN_HEAD:-}" ]]; then
    printf '%s\n' "$MOCK_ORIGIN_HEAD"
    exit 0
  fi
  exit 1
fi

if [[ "$*" == *" for-each-ref --format=%(refname:short) refs/remotes/origin"* ]]; then
  if [[ -n "${MOCK_ORIGIN_REFS:-}" ]]; then
    printf '%s\n' "$MOCK_ORIGIN_REFS"
  fi
  exit 0
fi

exit 0
SH
chmod +x "${TMP_BIN_DIR}/git"
PATH="${TMP_BIN_DIR}:$PATH"
export CALLS_FILE

require_cmd() {
  :
}

eval "$(extract_function resolve_checkout_ref)"
eval "$(extract_function checkout_clean_slate)"

: >"$CALLS_FILE"
export MOCK_ORIGIN_HEAD="origin/main"
export MOCK_ORIGIN_REFS=""
checkout_clean_slate "/tmp/repo" "" || fail "expected clean checkout from origin HEAD"
if ! grep -q "checkout --detach origin/main" "$CALLS_FILE"; then
  fail "expected detach checkout from origin/main"
fi
if ! grep -q "reset --hard origin/main" "$CALLS_FILE"; then
  fail "expected hard reset to origin/main"
fi
if ! grep -q "clean -fdx" "$CALLS_FILE"; then
  fail "expected clean -fdx"
fi
echo "PASS: uses origin HEAD for clean detached checkout"

: >"$CALLS_FILE"
export MOCK_ORIGIN_HEAD="origin/main"
export MOCK_ORIGIN_REFS="origin/main"
checkout_clean_slate "/tmp/repo" "feature/abc" || fail "expected requested ref checkout"
if ! grep -q "checkout --detach feature/abc" "$CALLS_FILE"; then
  fail "expected detach checkout from requested ref"
fi
if ! grep -q "reset --hard feature/abc" "$CALLS_FILE"; then
  fail "expected hard reset to requested ref"
fi
echo "PASS: honors explicit --ref for clean checkout"

: >"$CALLS_FILE"
export MOCK_ORIGIN_HEAD=""
export MOCK_ORIGIN_REFS=$'origin/HEAD\norigin/release'
checkout_clean_slate "/tmp/repo" "" || fail "expected fallback checkout from first origin ref"
if ! grep -q "checkout --detach origin/release" "$CALLS_FILE"; then
  fail "expected fallback detach checkout from origin/release"
fi
echo "PASS: falls back to first non-HEAD origin ref"

export MOCK_ORIGIN_HEAD=""
export MOCK_ORIGIN_REFS="origin/HEAD"
if checkout_clean_slate "/tmp/repo" "" >/dev/null 2>&1; then
  fail "expected clean checkout failure when no usable refs exist"
fi
echo "PASS: fails cleanly when no checkout ref can be resolved"

echo "All repo-clone clean-slate tests passed."
