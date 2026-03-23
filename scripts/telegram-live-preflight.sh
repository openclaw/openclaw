#!/usr/bin/env bash
set -euo pipefail

# Telegram live-test preflight:
# - named branch (not detached HEAD)
# - TELEGRAM_BOT_TOKEN present in .env.local
# - gateway runtime belongs to this worktree
# - auto-restart gateway from this worktree on missing/mismatch

WORKTREE="$(pwd -P)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
TOKEN_PRESENT="no"
RUNTIME_PID=""
RUNTIME_WORKTREE=""
FAIL=0

if [[ -f ".env.local" ]] && grep -Eq '^[[:space:]]*TELEGRAM_BOT_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]#]+' ".env.local"; then
  TOKEN_PRESENT="yes"
fi

resolve_runtime() {
  local pid=""
  pid="$(pgrep -f "openclaw gateway run --bind loopback --port 18789 --force" | head -n1 || true)"
  if [[ -z "${pid}" ]]; then
    pid="$(pgrep -f "dist/index.js gateway run --bind loopback --port 18789 --force" | head -n1 || true)"
  fi
  RUNTIME_PID="${pid}"
  if [[ -n "${RUNTIME_PID}" ]]; then
    RUNTIME_WORKTREE="$(lsof -a -p "${RUNTIME_PID}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  else
    RUNTIME_WORKTREE=""
  fi
}

restart_gateway_from_worktree() {
  pkill -9 -f "openclaw gateway run --bind loopback --port 18789 --force|dist/index.js gateway run --bind loopback --port 18789 --force" || true
  nohup pnpm openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-gateway-live-preflight.log 2>&1 &
}

if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
  FAIL=1
fi

if [[ "${TOKEN_PRESENT}" != "yes" ]]; then
  FAIL=1
fi

resolve_runtime
if [[ -z "${RUNTIME_PID}" || "${RUNTIME_WORKTREE}" != "${WORKTREE}" ]]; then
  restart_gateway_from_worktree || true
  for _ in {1..45}; do
    sleep 1
    resolve_runtime
    if [[ -n "${RUNTIME_PID}" && "${RUNTIME_WORKTREE}" == "${WORKTREE}" ]]; then
      break
    fi
  done
fi

if [[ -z "${RUNTIME_PID}" || "${RUNTIME_WORKTREE}" != "${WORKTREE}" ]]; then
  FAIL=1
fi

echo "branch=${BRANCH}"
echo "worktree=${WORKTREE}"
echo "runtime_pid=${RUNTIME_PID}"
echo "runtime_worktree=${RUNTIME_WORKTREE}"
echo "token_present=${TOKEN_PRESENT}"

if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
