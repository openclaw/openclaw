#!/usr/bin/env bash
set -euo pipefail

prompt="${1:-}"
timeout_ms="${2:-${RCA_LLM_TIMEOUT_MS:-15000}}"

if [[ -z "$prompt" ]]; then
  printf 'missing prompt\n' >&2
  exit 64
fi

if ! command -v openclaw >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  printf 'missing openclaw or jq\n' >&2
  exit 127
fi

model_ref="${RCA_PROVIDER_MODEL:-}"
if [[ -z "$model_ref" ]]; then
  printf 'missing RCA_PROVIDER_MODEL\n' >&2
  exit 64
fi

agent_id="${RCA_PROVIDER_AGENT_ID:-sre}"
timeout_seconds="$(awk -v ms="$timeout_ms" 'BEGIN { secs = int((ms + 999) / 1000); if (secs < 1) secs = 1; print secs }')"
session_id="${RCA_PROVIDER_SESSION_PREFIX:-rca}-$(date +%s)-$$-${RANDOM}"
message="/model ${model_ref}

${prompt}"

cmd=(
  openclaw
  agent
  --local
  --json
  --agent
  "$agent_id"
  --session-id
  "$session_id"
  --timeout
  "$timeout_seconds"
  --message
  "$message"
)

if [[ -n "${RCA_PROVIDER_THINKING:-}" ]]; then
  cmd+=(--thinking "$RCA_PROVIDER_THINKING")
fi

tmp_json="$(mktemp)"
tmp_err="$(mktemp)"
cleanup() {
  rm -f "$tmp_json" "$tmp_err"
}
trap cleanup EXIT

if ! "${cmd[@]}" >"$tmp_json" 2>"$tmp_err"; then
  sed -n '1,40p' "$tmp_err" >&2 || true
  exit 1
fi

assistant_text="$(
  jq -r '
    [
      .payloads[]?.text // empty
    ]
    | map(select(type == "string" and length > 0))
    | join("\n\n")
  ' "$tmp_json" 2>/dev/null || true
)"

if [[ -z "$assistant_text" ]]; then
  jq -c '.meta // {}' "$tmp_json" >&2 2>/dev/null || sed -n '1,40p' "$tmp_json" >&2 || true
  exit 1
fi

printf '%s\n' "$assistant_text"
