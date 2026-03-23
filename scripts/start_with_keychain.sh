#!/usr/bin/env bash
set -euo pipefail

get_secret() {
  local name="$1"
  security find-generic-password -a "alexanderkondrashov" -s "openclaw/${name}" -w 2>/dev/null || true
}

export OPENAI_API_KEY="$(get_secret OPENAI_API_KEY)"
export OPENROUTER_API_KEY="$(get_secret OPENROUTER_API_KEY)"
export GEMINI_API_KEY="$(get_secret GEMINI_API_KEY)"
export OPENCLAW_GATEWAY_TOKEN="$(get_secret OPENCLAW_GATEWAY_TOKEN)"
export TELEGRAM_BOT_TOKEN="$(get_secret TELEGRAM_BOT_TOKEN)"

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  python3 - <<'PY'
import json
from pathlib import Path
import os

cfg_path = Path('/Users/alexanderkondrashov/.openclaw/openclaw.json')
cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
cfg.setdefault('channels', {}).setdefault('telegram', {})['botToken'] = os.environ['TELEGRAM_BOT_TOKEN']
cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY
fi

cd "/Users/alexanderkondrashov/openclaw"
docker compose up -d
