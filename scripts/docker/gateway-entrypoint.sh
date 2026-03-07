#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "gateway-entrypoint requires root (set docker compose service user: root)" >&2
  exit 1
fi

if [ "${OPENCLAW_ENABLE_CRON:-1}" = "1" ] && command -v cron >/dev/null 2>&1; then
  # Start cron daemon once; jobs are configured by user crontabs via `crontab`.
  if ! pgrep -x cron >/dev/null 2>&1; then
    cron
  fi
fi

ensure_node_writable_dir() {
  local dir="$1"
  mkdir -p "$dir"
  chown -R node:node "$dir"
}

export COREPACK_HOME="${COREPACK_HOME:-/home/node/.cache/node/corepack}"
ensure_node_writable_dir /home/node/.cache
ensure_node_writable_dir "${PNPM_HOME:-/home/node/.local/share/pnpm}"
ensure_node_writable_dir "${NPM_CONFIG_PREFIX:-/home/node/.npm-global}"
ensure_node_writable_dir "${GOPATH:-/home/node/go}"

if command -v gosu >/dev/null 2>&1; then
  exec gosu node "$@"
fi

exec su -s /bin/sh node -c "$*"
