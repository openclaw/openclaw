#!/usr/bin/env bash
set -euo pipefail

# CyborgClaw Strike Echo Smoke Test (deterministic + provider pinned)
# - /reset must be its own message
# - one request per session (no A/B cross-talk)
# - FORCE agent=main
# - REQUIRE provider/model receipt: openai-codex / gpt-5.3-codex

TMP_PREFIX="/tmp/cc-echo"
ERR_PATTERNS='rate limit|FailoverError|INVALID_REQUEST|No session found|cooldown'

RUN_ID="$(date +%H%M%S)-$$"

SESSIONS=()
for i in $(seq 1 10); do
  SESSIONS+=("9${RUN_ID//-/}$(printf '%02d' "$i")")
done

cleanup() {
  rm -f "${TMP_PREFIX}-"*.out "${TMP_PREFIX}-"*.json 2>/dev/null || true
}
trap cleanup EXIT

echo "[strike_echo] run_id=$RUN_ID"
echo "[strike_echo] phase 1: resetting sessions..."

for s in "${SESSIONS[@]}"; do
  (openclaw agent --agent main --session-id "$s" --message "/reset" \
    < /dev/null > "${TMP_PREFIX}-${s}-reset.out" 2>&1) &
done
wait

echo "[strike_echo] phase 2: starting burst..."

for s in "${SESSIONS[@]}"; do
  (openclaw agent --agent main --session-id "$s" \
      --message "Reply with EXACTLY this text and nothing else: ECHO-$s" \
      --json < /dev/null > "${TMP_PREFIX}-${s}.json" 2>&1) &
done
wait

echo "[strike_echo] burst complete. verifying..."

# 1) Confirm we got 10 json output files
file_count="$(ls -1 ${TMP_PREFIX}-*.json 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$file_count" != "10" ]]; then
  echo "[strike_echo][FAIL] expected 10 json output files, got $file_count"
  ls -1 ${TMP_PREFIX}-*.json 2>/dev/null || true
  exit 1
fi

# 2) Confirm all 10 runs are ok, echo text matches, and provider/model pinned
bad=0
for s in "${SESSIONS[@]}"; do
  f="${TMP_PREFIX}-${s}.json"

  status="$(jq -r '.status // empty' "$f" 2>/dev/null || true)"
  text="$(jq -r '.result.payloads[0].text // empty' "$f" 2>/dev/null || true)"
  provider="$(jq -r '.result.meta.agentMeta.provider // empty' "$f" 2>/dev/null || true)"
  model="$(jq -r '.result.meta.agentMeta.model // empty' "$f" 2>/dev/null || true)"

  if [[ "$status" != "ok" ]]; then
    echo "[strike_echo][FAIL] $s status=$status"
    bad=1
    continue
  fi

  if [[ "$text" != "ECHO-$s" ]]; then
    echo "[strike_echo][FAIL] $s echo mismatch: got='$text' expected='ECHO-$s'"
    bad=1
  fi

  if [[ "$provider" != "openai-codex" || "$model" != "gpt-5.3-codex" ]]; then
    echo "[strike_echo][FAIL] $s provider/model mismatch: provider='$provider' model='$model' (expected openai-codex / gpt-5.3-codex)"
    bad=1
  fi
done

if [[ "$bad" != "0" ]]; then
  echo "[strike_echo][FAIL] provider/model pin or echo verification failed."
  exit 1
fi

# 3) Confirm no known error patterns appear anywhere in reset outputs or JSON
if rg -n -i "$ERR_PATTERNS" ${TMP_PREFIX}-* >/dev/null; then
  echo "[strike_echo][FAIL] detected error patterns:"
  rg -n -i "$ERR_PATTERNS" ${TMP_PREFIX}-* || true
  exit 1
fi

echo "[strike_echo][PASS] 10/10 echoes returned; provider/model pinned to openai-codex/gpt-5.3-codex; no error patterns detected."
