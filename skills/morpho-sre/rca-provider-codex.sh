#!/usr/bin/env bash
set -euo pipefail

# RCA provider: Codex via OpenAI API key (primary provider).
# Falls through to openclaw agent only if OPENAI_API_KEY is unset.
#
# Credential chain:
#   1. OPENAI_API_KEY env var (preferred — no OAuth needed)
#   2. Vault path secret/data/openclaw-sre/all-secrets key OPENAI_API_KEY
#   3. Fallback to openclaw agent (OAuth, slower)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

prompt="${1:-}"
timeout_ms="${2:-${RCA_LLM_TIMEOUT_MS:-15000}}"

if [[ -z "$prompt" ]]; then
  printf 'missing prompt\n' >&2
  exit 64
fi

MODEL="${RCA_PROVIDER_MODEL:-gpt-5.4}"

# --- Credential resolution ---
resolve_api_key() {
  # 1. Env var
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    printf '%s' "$OPENAI_API_KEY"
    return 0
  fi

  # 2. Vault (if vault CLI available and in-cluster)
  if command -v vault >/dev/null 2>&1; then
    local vault_key
    vault_key="$(vault kv get -field=OPENAI_API_KEY secret/openclaw-sre/all-secrets 2>/dev/null || true)"
    if [[ -n "$vault_key" ]]; then
      printf '%s' "$vault_key"
      return 0
    fi
  fi

  return 1
}

# --- API key path (preferred) ---
if api_key="$(resolve_api_key)"; then
  timeout_seconds="$(awk -v ms="$timeout_ms" 'BEGIN { secs = int((ms + 999) / 1000); if (secs < 1) secs = 1; print secs }')"

  payload="$(jq -n \
    --arg model "$MODEL" \
    --arg prompt "$prompt" \
    '{
      model: $model,
      input: $prompt,
      instructions: "You are an SRE RCA analyst. Respond with a single JSON object containing: mode, severity, canonical_category, summary, root_cause, hypotheses (array), and degradation_note (null if clean). No markdown fences.",
      reasoning: { effort: "high" }
    }'
  )"

  tmp_resp="$(mktemp)"
  tmp_err="$(mktemp)"
  cleanup() { rm -f "$tmp_resp" "$tmp_err"; }
  trap cleanup EXIT

  http_code="$(curl -s -w '%{http_code}' \
    --max-time "$timeout_seconds" \
    -X POST "https://api.openai.com/v1/responses" \
    -H "Authorization: Bearer ${api_key}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    -o "$tmp_resp" 2>"$tmp_err")"

  if [[ "$http_code" == "200" ]]; then
    # Extract text from the response
    output="$(jq -r '
      [.output[]? | select(.type == "message") | .content[]? | select(.type == "output_text") | .text] | join("\n\n")
    ' "$tmp_resp" 2>/dev/null || true)"

    if [[ -n "$output" ]]; then
      printf '%s\n' "$output"
      exit 0
    fi
  fi

  # API call failed — log and fall through to Claude
  printf 'codex api key call failed (http %s), falling back to claude\n' "$http_code" >&2
  cat "$tmp_err" >&2 2>/dev/null || true
fi

# --- Fallback: Claude via openclaw agent ---
printf 'codex unavailable, falling back to claude provider\n' >&2
exec "${SCRIPT_DIR}/rca-provider-claude.sh" "$@"
