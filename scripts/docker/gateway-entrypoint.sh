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

if command -v gosu >/dev/null 2>&1; then
  exec gosu node "$@"
fi

exec su -s /bin/sh node -c "$*"
