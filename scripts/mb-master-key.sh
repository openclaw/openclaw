#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${OPENCLAW_SAFE_ENV_FILE:-$ROOT_DIR/.env.safe}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Missing required command: docker" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Missing required command: python3" >&2
  exit 1
fi

read_env_value() {
  python3 - "$ENV_FILE" "$1" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

env_path = Path(sys.argv[1])
target = sys.argv[2]
for raw_line in env_path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in raw_line:
        continue
    key, value = raw_line.split("=", 1)
    if key.strip() != target:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    print(value)
    break
PY
}

CONFIG_DIR="$(read_env_value OPENCLAW_CONFIG_DIR)"
if [[ -z "$CONFIG_DIR" ]]; then
  CONFIG_DIR="$HOME/.openclaw"
fi
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
BACKUP_DIR="$CONFIG_DIR/backups"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
BACKUP_FILE="$BACKUP_DIR/openclaw.master-key.$STAMP.json"
LATEST_POINTER="$BACKUP_DIR/openclaw.master-key.latest"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing config file: $CONFIG_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
cp "$CONFIG_FILE" "$BACKUP_FILE"
printf '%s\n' "$BACKUP_FILE" > "$LATEST_POINTER"

python3 - "$CONFIG_FILE" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
config = json.loads(cfg_path.read_text())


def is_codex_ref(value: str) -> bool:
    low = value.lower()
    return (
        "codex" in low
        or "gpt-5" in low
        or "openai-codex" in low
        or "gpt-5.3" in low
    )


agents = config.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
model_cfg = defaults.setdefault("model", {})

safe_primary = "ollama/qwen3:14b"
preferred_fallbacks = [
    "ollama/qwen2.5:7b",
    "ollama/qwen2.5:3b",
    "moonshot/kimi-k2.5",
    "openrouter/moonshotai/kimi-k2.5",
    "anthropic/claude-sonnet-4-6",
]
existing_fallbacks = [
    item
    for item in (model_cfg.get("fallbacks") or [])
    if isinstance(item, str) and item.strip() and not is_codex_ref(item)
]

seen: set[str] = set()
merged_fallbacks: list[str] = []
for item in [*preferred_fallbacks, *existing_fallbacks]:
    if item == safe_primary:
        continue
    if item in seen:
        continue
    merged_fallbacks.append(item)
    seen.add(item)

model_cfg["primary"] = safe_primary
model_cfg["fallbacks"] = merged_fallbacks[:8]

context_tokens = defaults.get("contextTokens", 32768)
if not isinstance(context_tokens, int):
    context_tokens = 32768
defaults["contextTokens"] = max(8192, min(32768, context_tokens))

models = defaults.setdefault("models", {})
if not isinstance(models, dict):
    models = {}
    defaults["models"] = models

for key in list(models.keys()):
    if isinstance(key, str) and is_codex_ref(key):
        models.pop(key, None)


def ensure_model(model_id: str, alias: str, max_tokens: int) -> None:
    entry = models.setdefault(model_id, {})
    if not isinstance(entry, dict):
        entry = {}
        models[model_id] = entry
    entry.setdefault("alias", alias)
    params = entry.setdefault("params", {})
    if not isinstance(params, dict):
        params = {}
        entry["params"] = params
    current = params.get("maxTokens")
    if not isinstance(current, int) or current <= 0 or current > max_tokens:
        params["maxTokens"] = max_tokens


ensure_model("ollama/qwen3:14b", "Qwen3 14B", 2048)
ensure_model("ollama/qwen2.5:7b", "Qwen2.5 7B", 2048)
ensure_model("ollama/qwen2.5:3b", "Qwen2.5 3B", 2048)

for model_id, entry in list(models.items()):
    if not isinstance(model_id, str) or not isinstance(entry, dict):
        continue
    if model_id.startswith(("openrouter/", "moonshot/", "anthropic/")):
        params = entry.setdefault("params", {})
        if not isinstance(params, dict):
            params = {}
            entry["params"] = params
        current = params.get("maxTokens")
        if not isinstance(current, int) or current <= 0 or current > 2048:
            params["maxTokens"] = 2048

cfg_path.write_text(json.dumps(config, indent=2) + "\n")
PY

docker compose --env-file "$ENV_FILE" up -d --force-recreate openclaw-gateway openclaw-cli >/dev/null

echo "Master Key applied."
echo "Backup saved: $BACKUP_FILE"
echo "Codex partnership lane disabled; MB restored to local-first model chain."
echo "Gateway restarted."
