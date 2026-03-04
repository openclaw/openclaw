#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SCRIPT="${SCRIPT_DIR}/self-improve-pr.sh"

PASS=0
pass() {
  PASS=$((PASS + 1))
  printf 'ok %d - %s\n' "$PASS" "$1"
}
fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

for cmd in awk bash grep jq sed; do
  command -v "$cmd" >/dev/null 2>&1 || {
    printf 'skip - missing %s\n' "$cmd"
    exit 0
  }
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN="${TMP_DIR}/bin"
mkdir -p "$TMP_BIN"

REPO_DIR="${TMP_DIR}/repo"
mkdir -p "${REPO_DIR}/deploy/skills/morpho-sre/references"
cat > "${REPO_DIR}/deploy/skills/morpho-sre/HEARTBEAT.md" <<'EOF_HEARTBEAT'
# Morpho SRE Sentinel
EOF_HEARTBEAT
cat > "${REPO_DIR}/deploy/skills/morpho-sre/references/self-improvement-latest.md" <<'EOF_REPORT'
# Daily SRE Bot Self-Improvement Report
EOF_REPORT
git -C "$REPO_DIR" init -q
git -C "$REPO_DIR" config user.name "Test Bot"
git -C "$REPO_DIR" config user.email "test@example.com"
git -C "$REPO_DIR" add deploy/skills/morpho-sre/HEARTBEAT.md deploy/skills/morpho-sre/references/self-improvement-latest.md
git -C "$REPO_DIR" -c commit.gpgsign=false commit -qm "test baseline"

cat > "${TMP_BIN}/repo-clone.sh" <<'EOF_CLONE'
#!/usr/bin/env bash
set -euo pipefail
printf 'repo=morpho-org/openclaw-sre\n'
printf 'path=%s\n' "${MOCK_REPO_PATH:?}"
printf 'ref=main\n'
EOF_CLONE

cat > "${TMP_BIN}/autofix-pr.sh" <<'EOF_AUTOFIX'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"${MOCK_AUTOFIX_ARGS_FILE:?}"
printf 'pr_url=https://github.com/morpho-org/openclaw-sre/pull/999\n'
EOF_AUTOFIX

cat > "${TMP_BIN}/kubectl" <<'EOF_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"logs deployment/openclaw-sre"* ]]; then
  cat <<'LOGS'
slack: failed to send progress ack reaction: missing_scope
response: insufficient context to answer
github actions failed with 401 bad credentials
LOGS
  exit 0
fi
echo "kubectl mock unsupported args: $*" >&2
exit 1
EOF_KUBECTL

chmod +x "${TMP_BIN}/repo-clone.sh" "${TMP_BIN}/autofix-pr.sh" "${TMP_BIN}/kubectl"
PATH="${TMP_BIN}:$PATH"

AUTOFIX_ARGS_FILE="${TMP_DIR}/autofix.args"
MOCK_REPO_PATH="$REPO_DIR" \
MOCK_AUTOFIX_ARGS_FILE="$AUTOFIX_ARGS_FILE" \
SELF_IMPROVE_REPO_CLONE_SCRIPT="${TMP_BIN}/repo-clone.sh" \
SELF_IMPROVE_AUTOFIX_SCRIPT="${TMP_BIN}/autofix-pr.sh" \
SELF_IMPROVE_REPORT_PATH="deploy/skills/morpho-sre/references/self-improvement-latest.md" \
SELF_IMPROVE_HEARTBEAT_PATH="deploy/skills/morpho-sre/HEARTBEAT.md" \
SELF_IMPROVE_USE_KUBECTL=1 \
INCIDENT_STATE_DIR="${TMP_DIR}/state" \
bash "$TARGET_SCRIPT" --dry-run >/tmp/test-self-improve.log 2>&1 || {
  cat /tmp/test-self-improve.log >&2
  fail "self-improve script exited non-zero"
}

REPORT_FILE="${REPO_DIR}/deploy/skills/morpho-sre/references/self-improvement-latest.md"
HEARTBEAT_FILE="${REPO_DIR}/deploy/skills/morpho-sre/HEARTBEAT.md"

[[ -f "$REPORT_FILE" ]] || fail "report file missing"
[[ -f "$HEARTBEAT_FILE" ]] || fail "heartbeat file missing"
[[ -s "$AUTOFIX_ARGS_FILE" ]] || fail "autofix args capture missing"

grep -q "Daily SRE Bot Self-Improvement Report" "$REPORT_FILE" || fail "report title missing"
grep -q "github_auth_failure_count: 1" "$REPORT_FILE" || fail "github auth metric missing"
grep -q "<!-- self-improve:start -->" "$HEARTBEAT_FILE" || fail "managed block start missing"
grep -q "Managed guidance:" "$HEARTBEAT_FILE" || fail "managed guidance missing"
grep -q "github_auth_refresh" "$REPORT_FILE" || fail "focus key missing"
pass "evaluation report + managed heartbeat block created"

grep -q -- "--files deploy/skills/morpho-sre/HEARTBEAT.md,deploy/skills/morpho-sre/references/self-improvement-latest.md" "$AUTOFIX_ARGS_FILE" || fail "autofix files list missing"
grep -q -- "--dry-run" "$AUTOFIX_ARGS_FILE" || fail "autofix dry-run flag missing"
pass "autofix invoked with expected files"

MOCK_REPO_PATH="$REPO_DIR" \
MOCK_AUTOFIX_ARGS_FILE="$AUTOFIX_ARGS_FILE" \
SELF_IMPROVE_REPO_CLONE_SCRIPT="${TMP_BIN}/repo-clone.sh" \
SELF_IMPROVE_AUTOFIX_SCRIPT="${TMP_BIN}/autofix-pr.sh" \
SELF_IMPROVE_REPORT_PATH="deploy/skills/morpho-sre/references/self-improvement-latest.md" \
SELF_IMPROVE_HEARTBEAT_PATH="deploy/skills/morpho-sre/HEARTBEAT.md" \
SELF_IMPROVE_USE_KUBECTL=0 \
INCIDENT_STATE_DIR="${TMP_DIR}/state" \
bash "$TARGET_SCRIPT" --dry-run >/tmp/test-self-improve-no-kubectl.log 2>&1 || {
  cat /tmp/test-self-improve-no-kubectl.log >&2
  fail "self-improve script should succeed without kubectl usage"
}
pass "graceful without kubectl logs"

printf 'all tests passed (%d)\n' "$PASS"
