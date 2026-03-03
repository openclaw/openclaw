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
GIT_CALLS_FILE="${TMP_DIR}/git-calls.log"
GH_CALLS_FILE="${TMP_DIR}/gh-calls.log"
mkdir -p "$TMP_BIN_DIR"

cat > "${TMP_BIN_DIR}/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${GIT_CALLS_FILE:?}"

if [[ "$*" == *"ls-remote --heads origin "* ]]; then
  if [[ -n "${REMOTE_BRANCH_OID:-}" ]]; then
    printf '%s\trefs/heads/%s\n' "${REMOTE_BRANCH_OID}" "${HEAD_BRANCH:-test-branch}"
  fi
  exit 0
fi

if [[ "$*" == *"rev-parse origin/"* ]]; then
  printf '%s\n' "basebranchoid123"
  exit 0
fi

if [[ "$*" == *"diff --cached --name-status --find-renames --diff-filter=ACDMRT -z"* ]]; then
  printf 'A\0file.txt\0D\0old.txt\0R100\0old2.txt\0new2.txt\0'
  exit 0
fi

if [[ "$*" == *"show :file.txt"* ]]; then
  printf 'line-one\n'
  exit 0
fi

if [[ "$*" == *"show :new2.txt"* ]]; then
  printf 'line-two\n'
  exit 0
fi

if [[ "$*" == *"push -u origin "* ]]; then
  exit 0
fi

exit 0
SH
chmod +x "${TMP_BIN_DIR}/git"

cat > "${TMP_BIN_DIR}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${GH_CALLS_FILE:?}"

if [[ "${1:-}" == "api" && "${2:-}" == "graphql" ]]; then
  printf '{"data":{"createCommitOnBranch":{"commit":{"url":"https://github.com/morpho-org/openclaw-sre/commit/abc123"}}}}\n'
  exit 0
fi

if [[ "${1:-}" == "api" && "${2:-}" == "-X" && "${3:-}" == "POST" ]]; then
  printf '{}\n'
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
SH
chmod +x "${TMP_BIN_DIR}/gh"

PATH="${TMP_BIN_DIR}:$PATH"
export PATH GIT_CALLS_FILE GH_CALLS_FILE
export REMOTE_BRANCH_OID="feedface1234"
export HEAD_BRANCH="test-branch"

eval "$(extract_function resolve_remote_branch_oid)"
eval "$(extract_function ensure_remote_branch_for_signed_commit)"
eval "$(extract_function create_api_signed_commit)"

response="$(create_api_signed_commit "/tmp/repo" "morpho-org/openclaw-sre" "main" "test-branch" "fix: signed commit" "token123")" \
  || fail "expected signed commit helper to succeed"

if [[ "$response" != *"https://github.com/morpho-org/openclaw-sre/commit/abc123"* ]]; then
  fail "expected signed commit response to include commit URL"
fi
echo "PASS: signed commit helper returns GraphQL commit response"

if ! grep -q "repo=morpho-org/openclaw-sre" "$GH_CALLS_FILE"; then
  fail "expected GraphQL request to include repo slug"
fi
if ! grep -q "branch=test-branch" "$GH_CALLS_FILE"; then
  fail "expected GraphQL request to include branch"
fi
if ! grep -q "expectedHeadOid=feedface1234" "$GH_CALLS_FILE"; then
  fail "expected GraphQL request to use remote branch head OID"
fi
if ! grep -Fq "fileAdditions[][path]=file.txt" "$GH_CALLS_FILE"; then
  fail "expected staged addition path in GraphQL request"
fi
if ! grep -Fq "fileDeletions[][path]=old.txt" "$GH_CALLS_FILE"; then
  fail "expected staged deletion path in GraphQL request"
fi
if ! grep -Fq "fileDeletions[][path]=old2.txt" "$GH_CALLS_FILE"; then
  fail "expected rename source path in GraphQL deletions"
fi
if ! grep -Fq "fileAdditions[][path]=new2.txt" "$GH_CALLS_FILE"; then
  fail "expected rename target path in GraphQL additions"
fi
if grep -q "repos/morpho-org/openclaw-sre/git/refs" "$GH_CALLS_FILE"; then
  fail "did not expect branch creation API call when branch already exists"
fi
echo "PASS: signed commit GraphQL payload includes additions/deletions/rename + expected head"

if ! grep -q "show :file.txt" "$GIT_CALLS_FILE"; then
  fail "expected staged contents read for file addition"
fi
if ! grep -q "show :new2.txt" "$GIT_CALLS_FILE"; then
  fail "expected staged contents read for rename target"
fi
echo "PASS: helper reads staged blob contents for additions"

echo "All autofix-pr signed commit tests passed."
