#!/usr/bin/env bash
# Healthcheck + smoke/fallback tests for the LiteLLM provider gateway.
# Reads LITELLM_MASTER_KEY from .env (gitignored). Never prints the key.
set -euo pipefail
cd "$(dirname "$0")"

BASE="${LITELLM_BASE:-http://127.0.0.1:4000}"
MK="$(grep -E '^LITELLM_MASTER_KEY=' .env 2>/dev/null | cut -d= -f2- || true)"
AUTH=(); [ -n "$MK" ] && AUTH=(-H "Authorization: Bearer $MK")

echo "== 1) liveliness (no auth) =="
curl -fsS --max-time 5 "$BASE/health/liveliness"; echo

echo "== 2) readiness =="
curl -fsS --max-time 5 "$BASE/health/readiness"; echo

echo "== 3) completion via openclaw-auto (primary = OpenRouter Claude) =="
curl -fsS --max-time 60 "$BASE/v1/chat/completions" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw-auto","messages":[{"role":"user","content":"Ответь одним словом: OK"}],"max_tokens":20}' \
  | python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False);print('model:',d.get('model'));print('content:',repr(d['choices'][0]['message']['content'][:80]))"

echo "== 4) fallback drill (forces primary failure, expect Ollama) =="
curl -fsS --max-time 90 "$BASE/v1/chat/completions" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw-auto","messages":[{"role":"user","content":"Reply one word: WORKING /no_think"}],"max_tokens":120,"temperature":0,"mock_testing_fallbacks":true}' \
  | python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False);m=d['choices'][0]['message'];print('fallback model:',d.get('model'));print('answered:',bool((m.get('content') or m.get('reasoning_content') or '').strip()))"

echo "== done =="
