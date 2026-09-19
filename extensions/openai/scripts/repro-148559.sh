#!/usr/bin/env bash
# Reproduces #148559 through the real embedded-run entry point in a throwaway state dir.
#
#   extensions/openai/scripts/repro-148559.sh [--with-base-url] <openclaw command...>
#
# Examples:
#   extensions/openai/scripts/repro-148559.sh openclaw                    # installed CLI
#   extensions/openai/scripts/repro-148559.sh node scripts/run-node.mjs   # this checkout
#
# The config authors an inline OpenAI API key and enables the codex plugin entry.
# Without --with-base-url no api/baseUrl is authored, which is the failing shape;
# with it the existing workaround is in place, which must keep working.
#
# The key defaults to a fake value, so the question is whether the run reaches the
# provider (401 from OpenAI) or is rejected before any request is made. Export
# OPENAI_REPRO_API_KEY with a real key to see nano answer; the key is written only to
# the throwaway config and never printed.
set -euo pipefail

with_base_url=0
if [ "${1:-}" = "--with-base-url" ]; then
  with_base_url=1
  shift
fi
api_key="${OPENAI_REPRO_API_KEY:-sk-test-not-a-real-key-000000000000000000}"

run_one() {
  local model="$1"; shift
  local state
  state="$(mktemp -d "${TMPDIR:-/tmp}/oc-148559-XXXXXX")"
  mkdir -p "$state/home"
  local base_url_line=""
  if [ "$with_base_url" = 1 ]; then
    base_url_line=', "baseUrl": "https://api.openai.com/v1"'
  fi
  cat > "$state/openclaw.json" <<JSON
{
  "agents": { "defaults": { "model": { "primary": "openai/gpt-5.4-nano" } } },
  "models": { "providers": { "openai": { "apiKey": "${api_key}"${base_url_line} } } },
  "plugins": { "entries": { "openai": { "enabled": true }, "codex": { "enabled": true } } }
}
JSON
  echo "== $model (baseUrl authored: $with_base_url)"
  OPENCLAW_STATE_DIR="$state" OPENCLAW_CONFIG_PATH="$state/openclaw.json" HOME="$state/home" \
    "$@" agent --local --agent main --model "$model" -m "Reply with the single word OK." 2>&1 \
    | grep -E 'model-fallback/decision|^[A-Za-z]' | grep -v 'bootstrap import guard' \
    | sed -E 's/sk-[A-Za-z0-9_-]+/sk-****/g' | tail -2 || true
  rm -rf "$state"
}

run_one openai/gpt-5.4-nano "$@"
run_one openai/gpt-5.4-mini "$@"
