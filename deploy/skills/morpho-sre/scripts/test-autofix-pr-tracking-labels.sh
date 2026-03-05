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

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  [[ "$expected" == "$actual" ]] || fail "$msg (expected: '$expected'; got: '$actual')"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN_DIR="${TMP_DIR}/bin"
GH_CALLS_FILE="${TMP_DIR}/gh-calls.log"
LINEAR_CALLS_FILE="${TMP_DIR}/linear-calls.log"
mkdir -p "$TMP_BIN_DIR"

cat > "${TMP_BIN_DIR}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${GH_CALLS_FILE:?}"
if [[ "${1:-}" == "pr" && "${2:-}" == "edit" ]]; then
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
SH
chmod +x "${TMP_BIN_DIR}/gh"

cat > "${TMP_BIN_DIR}/linear-ticket-api.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${LINEAR_CALLS_FILE:?}"
if [[ "${1:-}" == "issue" && "${2:-}" == "ensure-label" ]]; then
  printf 'labeled\t%s\t%s\n' "${3:-}" "${4:-}"
  exit 0
fi
echo "unexpected linear-ticket-api invocation: $*" >&2
exit 1
SH
chmod +x "${TMP_BIN_DIR}/linear-ticket-api.sh"

PATH="${TMP_BIN_DIR}:$PATH"
export PATH GH_CALLS_FILE LINEAR_CALLS_FILE

# function dependency for retry branch in apply_pr_tracking_label
refresh_auth_context() {
  :
}

SCRIPT_DIR="$TMP_BIN_DIR"
eval "$(extract_function collect_linear_issue_refs)"
eval "$(extract_function resolve_linear_issue_refs)"
eval "$(extract_function apply_pr_tracking_label)"
eval "$(extract_function apply_ticket_tracking_labels)"

refs_output="$(
  collect_linear_issue_refs \
    "fix(sre:pla-678): enforce live linear ticket updates" \
    "branch feature/pla-678-generic-retry and follow-up PLA-701"
)"
refs=()
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  refs+=("$line")
done <<< "$refs_output"

assert_eq "2" "${#refs[@]}" "deduped issue refs count"
assert_eq "PLA-678" "${refs[0]}" "first issue ref uppercased"
assert_eq "PLA-701" "${refs[1]}" "second issue ref extracted"
echo "PASS: collect_linear_issue_refs extracts + dedupes refs"

BODY_FILE="${TMP_DIR}/body.md"
cat >"$BODY_FILE" <<'EOF'
Fixes PLA-999 and references pla-701 in notes.
EOF

resolved_output="$(
  resolve_linear_issue_refs "$BODY_FILE" "[OPENCLAW-SRE] title PLA-678" "commit touches pla-701"
)"
resolved_refs=()
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  resolved_refs+=("$line")
done <<< "$resolved_output"
assert_eq "3" "${#resolved_refs[@]}" "resolved issue refs count with body"
assert_eq "PLA-678" "${resolved_refs[0]}" "title issue ref kept"
assert_eq "PLA-701" "${resolved_refs[1]}" "commit issue ref kept"
assert_eq "PLA-999" "${resolved_refs[2]}" "body issue ref appended"
echo "PASS: resolve_linear_issue_refs merges title/commit/body refs"

apply_pr_tracking_label "morpho-org/openclaw-sre" "https://github.com/morpho-org/openclaw-sre/pull/999" "openclaw-sre" \
  || fail "expected PR tracking label to succeed"
if ! grep -q "pr edit https://github.com/morpho-org/openclaw-sre/pull/999 --repo morpho-org/openclaw-sre --add-label openclaw-sre" "$GH_CALLS_FILE"; then
  fail "expected gh pr edit with tracking label"
fi
echo "PASS: apply_pr_tracking_label calls gh pr edit --add-label"

export AUTO_PR_LINEAR_TICKET_API="${TMP_BIN_DIR}/linear-ticket-api.sh"
apply_ticket_tracking_labels "openclaw-sre" PLA-678 PLA-701 \
  || fail "expected Linear ticket labeling to succeed"
if ! grep -q "issue ensure-label PLA-678 openclaw-sre" "$LINEAR_CALLS_FILE"; then
  fail "expected PLA-678 label call"
fi
if ! grep -q "issue ensure-label PLA-701 openclaw-sre" "$LINEAR_CALLS_FILE"; then
  fail "expected PLA-701 label call"
fi
echo "PASS: apply_ticket_tracking_labels labels each issue"

echo "All autofix-pr tracking label tests passed."
