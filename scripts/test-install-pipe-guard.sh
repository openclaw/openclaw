#!/bin/bash
# Test harness for the pipe guard (PR #82918).
# Verifies the guard triggers ONLY for piped execution (curl | bash),
# not for direct, command-string, or process-substitution invocation.

set -euo pipefail

BOLD='\033[1m'
NC='\033[0m'
GREEN='\033[38;2;0;229;204m'
RED='\033[38;2;230;57;70m'

pass=0
fail=0

ok() { pass=$((pass+1)); echo -e "  ${GREEN}✓ PASS${NC}  $1"; }
ko() { fail=$((fail+1)); echo -e "  ${RED}✗ FAIL${NC}  $1"; }
announce() { echo -e "\n${BOLD}── $1 ──${NC}"; }

# ---------------------------------------------------------------------------
# Build a minimal test script that just prints diagnostic state and exits
# ---------------------------------------------------------------------------
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

cat > "$TMPDIR_TEST/stub.sh" << 'STUB'
#!/bin/bash
# Minimal pipe-guard stub that mirrors the real guard logic
if [ -z "${BASH_SOURCE[0]:-}" ] && [ -z "${_OPENCLAW_PIPE_BUFFERED:-}" ] && [ -p /dev/stdin ]; then
    _pipe_tmp=$(mktemp)
    cat > "$_pipe_tmp"
    echo "GUARD_TRIGGERED=true"
    _OPENCLAW_PIPE_BUFFERED="$_pipe_tmp" exec bash "$_pipe_tmp" "$@"
fi
if [ -n "${_OPENCLAW_PIPE_BUFFERED:-}" ]; then
    echo "BUFFERED_EXEC=true"
    if [ "${_OPENCLAW_PIPE_BUFFERED}" = "${BASH_SOURCE[0]:-}" ]; then
        rm -f "$_OPENCLAW_PIPE_BUFFERED" 2>/dev/null || true
    fi
    unset _OPENCLAW_PIPE_BUFFERED
fi
echo "REACHED_BODY=true"
echo "BASH_SOURCE=${BASH_SOURCE[0]:-<empty>}"
echo "STDIN_IS_TTY=$([ -t 0 ] && echo yes || echo no)"
echo "STDIN_IS_PIPE=$([ -p /dev/stdin ] && echo yes || echo no)"
STUB
chmod +x "$TMPDIR_TEST/stub.sh"

# ---------------------------------------------------------------------------
# Test 1: Direct file execution (bash script.sh)
# Guard must NOT trigger.
# ---------------------------------------------------------------------------
announce "Direct file execution"

direct_out="$(bash "$TMPDIR_TEST/stub.sh" 2>&1)"
if echo "$direct_out" | grep -q "GUARD_TRIGGERED=true"; then
    ko "direct → guard triggered (should not)"
else
    ok "direct → guard did NOT trigger"
fi
if echo "$direct_out" | grep -q "REACHED_BODY=true"; then
    ok "direct → script body reached"
else
    ko "direct → script body NOT reached"
fi

# ---------------------------------------------------------------------------
# Test 2: Command-string execution (bash -c "$(cat script.sh)")
# Guard must NOT trigger even though BASH_SOURCE is empty.
# ---------------------------------------------------------------------------
announce "Command-string execution (bash -c)"

cmdstr_out="$(bash -c "$(cat "$TMPDIR_TEST/stub.sh")" 2>&1)"
if echo "$cmdstr_out" | grep -q "GUARD_TRIGGERED=true"; then
    ko "bash -c → guard triggered (should not)"
else
    ok "bash -c → guard did NOT trigger"
fi
if echo "$cmdstr_out" | grep -q "REACHED_BODY=true"; then
    ok "bash -c → script body reached"
else
    ko "bash -c → script body NOT reached"
fi

# ---------------------------------------------------------------------------
# Test 3: Piped execution (cat script.sh | bash)
# Guard MUST trigger and re-exec from the buffered temp file.
# ---------------------------------------------------------------------------
announce "Piped execution (cat | bash)"

pipe_out="$(cat "$TMPDIR_TEST/stub.sh" | bash 2>&1)"
if echo "$pipe_out" | grep -q "GUARD_TRIGGERED=true"; then
    ok "pipe → guard triggered"
else
    ko "pipe → guard did NOT trigger (should have)"
fi
if echo "$pipe_out" | grep -q "BUFFERED_EXEC=true"; then
    ok "pipe → buffered re-exec reached"
else
    ko "pipe → buffered re-exec NOT reached"
fi
if echo "$pipe_out" | grep -q "REACHED_BODY=true"; then
    ok "pipe → script body reached"
else
    ko "pipe → script body NOT reached"
fi

# ---------------------------------------------------------------------------
# Test 4: Process substitution (bash <(cat script.sh))
# Guard must NOT trigger (BASH_SOURCE is set to /dev/fd/... or /proc/...).
# ---------------------------------------------------------------------------
announce "Process substitution (bash <(...))"

procsub_out="$(bash <(cat "$TMPDIR_TEST/stub.sh") 2>&1)"
if echo "$procsub_out" | grep -q "GUARD_TRIGGERED=true"; then
    ko "process-sub → guard triggered (should not)"
else
    ok "process-sub → guard did NOT trigger"
fi
if echo "$procsub_out" | grep -q "REACHED_BODY=true"; then
    ok "process-sub → script body reached"
else
    ko "process-sub → script body NOT reached"
fi

# ---------------------------------------------------------------------------
# Test 5: Stdin from /dev/null (common in CI/Docker)
# Guard must NOT trigger.
# ---------------------------------------------------------------------------
announce "Stdin from /dev/null (CI/Docker)"

devnull_out="$(bash "$TMPDIR_TEST/stub.sh" < /dev/null 2>&1)"
if echo "$devnull_out" | grep -q "GUARD_TRIGGERED=true"; then
    ko "/dev/null → guard triggered (should not)"
else
    ok "/dev/null → guard did NOT trigger"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Results: ${GREEN}${pass} passed${NC}, ${RED}${fail} failed${NC}"
if [[ $fail -eq 0 ]]; then
    echo -e "${GREEN}All invocation tests passed.${NC}"
else
    echo -e "${RED}Some invocation tests failed!${NC}"
    exit 1
fi
