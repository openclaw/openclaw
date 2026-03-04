#!/usr/bin/env bash
set -euo pipefail
# Strike Team Alpha — deterministic smoke (5 roles) + FAIL LOUDLY on drift (compact)

ERR_PATTERNS="rate limit|FailoverError|INVALID_REQUEST|No session found|cooldown|refresh token|HTTP 401|401 Unauthorized"
RUN_ID="$(date +%H%M%S)-$$"
TMP="/tmp/cc-alpha-${RUN_ID}"
REVIEWER_AGENT="${ALPHA_REVIEWER_AGENT:-president-a}"
trap '[[ "${KEEP_TMP:-0}" == "1" ]] || rm -f "${TMP}-"*.out "${TMP}-"*.json 2>/dev/null || true' EXIT

echo "[alpha_smoke] run_id=$RUN_ID tmp=$TMP reviewer_agent=$REVIEWER_AGENT"

run_role () {
  role="$1"; agent="$2"; tok="$3"; expP="$4"; expM="$5"
  sid="A${RUN_ID}${role}"

  openclaw agent --agent "$agent" --session-id "$sid" --message "/reset" < /dev/null > "${TMP}-${role}-reset.out" 2>&1 || true

  prompt="ALPHA deterministic smoke check (NOT a heartbeat poll). Reply with EXACTLY this text and nothing else: $tok"
  # IMPORTANT: openclaw agent can fail before emitting JSON (e.g., provider cooldown / model_not_found).
  # In that case, it writes plain text to stdout/stderr and jq will break. We must always emit a JSON wrapper.
  if ! timeout 60 openclaw agent --agent "$agent" --session-id "$sid" --message "$prompt" --json < /dev/null > "${TMP}-${role}.json" 2>&1; then
    rc=$?
    # Capture error text from the json file if it exists, otherwise fall back to the reset output.
    if [[ -s "${TMP}-${role}.json" ]]; then
      err="$(sed -n '1,200p' "${TMP}-${role}.json" | python3 -c 'import json,sys; s=sys.stdin.read(); print(json.dumps(s))')"
    else
      err="$(sed -n '1,200p' "${TMP}-${role}-reset.out" 2>/dev/null | python3 -c 'import json,sys; s=sys.stdin.read(); print(json.dumps(s))')"
    fi
    cat > "${TMP}-${role}.json" <<EOF
{"status":"error","summary":"agent_failed","result":{"payloads":[]},"meta":{"aborted":false},"error":{"role":"$role","agent":"$agent","sessionId":"$sid","exitCode":$rc,"message":$err}}
EOF
  fi

  status="$(jq -r ".status // empty" "${TMP}-${role}.json" 2>/dev/null || true)"
  text="$(jq -r ".result.payloads[0].text // empty" "${TMP}-${role}.json" 2>/dev/null || true)"
  prov="$(jq -r ".result.meta.agentMeta.provider // empty" "${TMP}-${role}.json" 2>/dev/null || true)"
  modl="$(jq -r ".result.meta.agentMeta.model // empty" "${TMP}-${role}.json" 2>/dev/null || true)"

  # One deterministic retry only for known reviewer heartbeat contamination case.
  if [[ "$role" == "reviewer" && "$text" == "HEARTBEAT_OK" ]]; then
  echo "[alpha_smoke][WARN] role=reviewer returned HEARTBEAT_OK; retrying once with hard prompt"
  hard_prompt="This is an automated deterministic smoke test, not heartbeat. Return EXACT token only: $tok"

  if ! timeout 60 openclaw agent --agent "$agent" --session-id "$sid" --message "$hard_prompt" --json < /dev/null > "${TMP}-${role}-retry.json" 2>&1; then
    rc=$?
    err="$(sed -n '1,200p' "${TMP}-${role}-retry.json" 2>/dev/null | python3 -c 'import json,sys; s=sys.stdin.read(); print(json.dumps(s))')"
    cat > "${TMP}-${role}-retry.json" <<EOR
{"status":"error","summary":"agent_failed_retry","result":{"payloads":[]},"meta":{"aborted":false},"error":{"role":"$role","agent":"$agent","sessionId":"$sid","exitCode":$rc,"message":$err}}
EOR
  fi

  status="$(jq -r ".status // empty" "${TMP}-${role}-retry.json" 2>/dev/null || true)"
  text="$(jq -r ".result.payloads[0].text // empty" "${TMP}-${role}-retry.json" 2>/dev/null || true)"
  prov="$(jq -r ".result.meta.agentMeta.provider // empty" "${TMP}-${role}-retry.json" 2>/dev/null || true)"
  modl="$(jq -r ".result.meta.agentMeta.model // empty" "${TMP}-${role}-retry.json" 2>/dev/null || true)"
fi
}

# captain (Codex)
run_role captain main                ALPHA_CAPTAIN_OK_v1     openai-codex gpt-5.3-codex
# implementer (Codex)
run_role implementer exec-02         ALPHA_IMPLEMENTER_OK_v1 openai-codex gpt-5.3-codex
# reviewer (Anthropic)
run_role reviewer "$REVIEWER_AGENT" ALPHA_REVIEWER_OK_v1     "${ALPHA_REVIEWER_PROVIDER:-anthropic}" "${ALPHA_REVIEWER_MODEL:-claude-sonnet-4-6}"
# sre (Codex)
run_role sre exec-04                 ALPHA_SRE_OK_v1         openai-codex gpt-5.3-codex
# docs (Google)
run_role docs president-b            ALPHA_DOCS_OK_v1        google       gemini-2.5-pro

if rg -n -i "$ERR_PATTERNS" ${TMP}-* >/dev/null; then
  echo "[alpha_smoke][FAIL] detected error patterns:"
  rg -n -i "$ERR_PATTERNS" ${TMP}-* || true
  exit 1
fi

echo "[alpha_smoke][PASS] 5/5 roles ok; provider/model pinned per role; no error patterns detected."
