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
LATEST_POINTER="$BACKUP_DIR/openclaw.master-key.latest"
REQUESTED_BACKUP="${1:-}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing config file: $CONFIG_FILE" >&2
  exit 1
fi

if [[ -n "$REQUESTED_BACKUP" ]]; then
  BACKUP_FILE="$REQUESTED_BACKUP"
elif [[ -f "$LATEST_POINTER" ]]; then
  BACKUP_FILE="$(cat "$LATEST_POINTER")"
else
  BACKUP_FILE="$(ls -1t "$BACKUP_DIR"/openclaw.master-key.*.json 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "No backup file found to restore." >&2
  echo "Expected pattern: $BACKUP_DIR/openclaw.master-key.*.json" >&2
  exit 1
fi

cp "$BACKUP_FILE" "$CONFIG_FILE"
docker compose --env-file "$ENV_FILE" up -d --force-recreate openclaw-gateway openclaw-cli >/dev/null

echo "Restore complete."
echo "Restored from: $BACKUP_FILE"
echo "Gateway restarted."
