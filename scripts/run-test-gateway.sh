#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CLAWDBOT_TEST_GATEWAY_PORT:-19001}"
STATE_DIR="${CLAWDBOT_TEST_STATE_DIR:-$HOME/.clawdbot-test}"
CONFIG_PATH="${CLAWDBOT_TEST_CONFIG_PATH:-$STATE_DIR/clawdbot.json}"
MAIN_CONFIG_PATH="${CLAWDBOT_MAIN_CONFIG_PATH:-$HOME/.clawdbot/clawdbot.json}"
TEST_WORKSPACE="${CLAWDBOT_TEST_WORKSPACE:-$HOME/clawd-test}"

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  if command -v nix-shell >/dev/null 2>&1 && [[ -z "${IN_NIX_SHELL:-}" ]]; then
    exec nix-shell -p nodejs_22 pnpm --run "$0 $*"
  fi
  echo "Missing node/pnpm. Install them or run inside nix-shell." >&2
  exit 1
fi

if [[ ! -f "$MAIN_CONFIG_PATH" ]]; then
  echo "Main config not found at $MAIN_CONFIG_PATH" >&2
  exit 1
fi

mkdir -p "$STATE_DIR" "$TEST_WORKSPACE"

if [[ ! -f "$CONFIG_PATH" ]]; then
  python - "$MAIN_CONFIG_PATH" "$CONFIG_PATH" "$PORT" "$TEST_WORKSPACE" <<'PY'
import json
import sys
from pathlib import Path

main_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
port = int(sys.argv[3])
workspace = sys.argv[4]

with main_path.open() as f:
    data = json.load(f)

data.setdefault("gateway", {})
data["gateway"]["port"] = port
data["gateway"]["bind"] = "loopback"
data["gateway"]["mode"] = "local"

data.setdefault("agents", {})
data["agents"].setdefault("defaults", {})["workspace"] = workspace

channels = data.get("channels") or {}
if "telegram" in channels:
    channels["telegram"]["enabled"] = False
    data["channels"] = channels

out_path.parent.mkdir(parents=True, exist_ok=True)
with out_path.open("w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
fi

cd "$ROOT_DIR"

pnpm install
pnpm build

export CLAWDBOT_STATE_DIR="$STATE_DIR"
export CLAWDBOT_CONFIG_PATH="$CONFIG_PATH"

node dist/entry.js gateway --port "$PORT"
