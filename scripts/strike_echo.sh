#!/usr/bin/env bash
set -euo pipefail

# CyborgClaw Strike Echo Smoke Test
# Goal: prove provider lane cap behaves under burst load and returns correct outputs.

SESSIONS=(9101 9102 9103 9104 9105)
TMP_PREFIX="/tmp/cc-echo"
ERR_PATTERNS='rate limit|FailoverError|INVALID_REQUEST|No session found|cooldown'

cleanup() {
  rm -f "${TMP_PREFIX}-"*.out 2>/dev/null || true
}
trap cleanup EXIT

echo "[strike_echo] starting burst..."

# Fire 10 requests (A/B across 5 sessions). Detach stdin/stdout to avoid bash job-control stops.
for s in "${SESSIONS[@]}"; do
  (openclaw agent --session-id "$s" --message "/reset Reply with EXACTLY this text and nothing else: ECHO-$s-A" \
    < /dev/null > "${TMP_PREFIX}-${s}-A.out" 2>&1) &
  (openclaw agent --session-id "$s" --message "/reset Reply with EXACTLY this text and nothing else: ECHO-$s-B" \
    < /dev/null > "${TMP_PREFIX}-${s}-B.out" 2>&1) &
done

wait
echo "[strike_echo] burst complete. verifying..."

# 1) Confirm we got 10 output files
file_count="$(ls -1 ${TMP_PREFIX}-*.out 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$file_count" != "10" ]]; then
  echo "[strike_echo][FAIL] expected 10 output files, got $file_count"
  ls -1 ${TMP_PREFIX}-*.out 2>/dev/null || true
  exit 1
fi

# 2) Confirm 10/10 echoed markers exist
match_count="$(rg -n "ECHO-910[1-5]-[AB]" ${TMP_PREFIX}-*.out | wc -l | tr -d ' ')"
if [[ "$match_count" != "10" ]]; then
  echo "[strike_echo][FAIL] expected 10 echo matches, got $match_count"
  echo "---- file previews ----"
  for f in ${TMP_PREFIX}-*.out; do
    echo "===== $f ====="
    sed -n '1,5p' "$f" || true
  done
  exit 1
fi

# 3) Confirm no known error patterns appear in outputs
if rg -n -i "$ERR_PATTERNS" ${TMP_PREFIX}-*.out >/dev/null; then
  echo "[strike_echo][FAIL] detected error patterns in outputs:"
  rg -n -i "$ERR_PATTERNS" ${TMP_PREFIX}-*.out || true
  exit 1
fi

echo "[strike_echo][PASS] 10/10 echoes returned; no error patterns detected."
