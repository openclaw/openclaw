#!/usr/bin/env bash
set -euo pipefail

# CyborgClaw Strike Echo Smoke Test (deterministic)
# Fixes two hazards:
# 1) /reset parsing ambiguity: /reset must be its own message
# 2) session cross-talk: never send concurrent A/B turns into the same session
#
# Approach: 2-phase (reset -> burst) + 10 unique sessions per run.

TMP_PREFIX="/tmp/cc-echo"
ERR_PATTERNS='rate limit|FailoverError|INVALID_REQUEST|No session found|cooldown'

# Unique-ish run id: HHMMSS + PID (no external deps)
RUN_ID="$(date +%H%M%S)-$$"

# Build 10 session ids that won't collide with other runs
# (keeps repeated executions “stateless enough”)
SESSIONS=()
for i in $(seq 1 10); do
  SESSIONS+=("9${RUN_ID//-/}$(printf '%02d' "$i")")
done

cleanup() {
  rm -f "${TMP_PREFIX}-"*.out 2>/dev/null || true
}
trap cleanup EXIT

echo "[strike_echo] run_id=$RUN_ID"
echo "[strike_echo] phase 1: resetting sessions..."

# Phase 1: reset all sessions (concurrently)
for s in "${SESSIONS[@]}"; do
  (openclaw agent --session-id "$s" --message "/reset" \
    < /dev/null > "${TMP_PREFIX}-${s}-reset.out" 2>&1) &
done
wait

echo "[strike_echo] phase 2: starting burst..."

# Phase 2: one echo per session (concurrently)
for s in "${SESSIONS[@]}"; do
  (openclaw agent --session-id "$s" --message "Reply with EXACTLY this text and nothing else: ECHO-$s" \
    < /dev/null > "${TMP_PREFIX}-${s}.out" 2>&1) &
done
wait

echo "[strike_echo] burst complete. verifying..."

# 1) Confirm we got 10 echo outputs
file_count="$(ls -1 ${TMP_PREFIX}-*.out 2>/dev/null | grep -v -- '-reset\.out$' | wc -l | tr -d ' ')"
if [[ "$file_count" != "10" ]]; then
  echo "[strike_echo][FAIL] expected 10 echo output files, got $file_count"
  ls -1 ${TMP_PREFIX}-*.out 2>/dev/null || true
  exit 1
fi

# 2) Confirm 10/10 echoed markers exist (one per file)
match_count="$(rg -n "ECHO-9[0-9]{7,}" ${TMP_PREFIX}-*.out | grep -v -- '-reset\.out:' | wc -l | tr -d ' ')"
if [[ "$match_count" != "10" ]]; then
  echo "[strike_echo][FAIL] expected 10 echo matches, got $match_count"
  echo "---- file previews ----"
  for f in ${TMP_PREFIX}-*.out; do
    [[ "$f" == *-reset.out ]] && continue
    echo "===== $f ====="
    sed -n '1,8p' "$f" || true
  done
  exit 1
fi

# 3) Confirm no known error patterns appear in echo outputs
if rg -n -i "$ERR_PATTERNS" ${TMP_PREFIX}-*.out >/dev/null; then
  echo "[strike_echo][FAIL] detected error patterns in outputs:"
  rg -n -i "$ERR_PATTERNS" ${TMP_PREFIX}-*.out || true
  exit 1
fi

echo "[strike_echo][PASS] 10/10 echoes returned; no error patterns detected."
