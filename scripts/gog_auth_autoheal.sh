#!/bin/bash

# gog Google 授权自动修复脚本
# - 有 token: 直接退出 0
# - 无 token: 自动触发 gog login（仍需用户完成 OAuth 同意）
#
# 用法:
#   bash scripts/gog_auth_autoheal.sh <email> [services]
#   bash scripts/gog_auth_autoheal.sh <email> [services] --check-only
#
# 示例:
#   bash scripts/gog_auth_autoheal.sh kyle@chancecon.co.nz user
#   bash scripts/gog_auth_autoheal.sh kyle@chancecon.co.nz all --check-only

set -u

EMAIL="${1:-}"
SERVICES="${2:-user}"
MODE="${3:-}"
GOG_TIMEOUT_SECONDS="${GOG_TIMEOUT_SECONDS:-20}"

if [[ -z "$EMAIL" ]]; then
  echo "Usage: bash scripts/gog_auth_autoheal.sh <email> [services] [--check-only]"
  exit 2
fi

if ! command -v gog >/dev/null 2>&1; then
  echo "ERROR: gog command not found"
  exit 2
fi
run_with_timeout() {
  local timeout="$1"
  shift
  local out_file
  out_file="$(mktemp)"
  "$@" >"$out_file" 2>&1 &
  local cmd_pid=$!
  local elapsed=0

  while kill -0 "$cmd_pid" 2>/dev/null; do
    if (( elapsed >= timeout )); then
      kill -TERM "$cmd_pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$cmd_pid" 2>/dev/null || true
      cat "$out_file"
      rm -f "$out_file"
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  wait "$cmd_pid"
  local rc=$?
  cat "$out_file"
  rm -f "$out_file"
  return "$rc"
}

# 统一 keyring backend 为 file，避免系统钥匙串交互/解锁导致的持久化不稳定
KEYRING_OUTPUT="$(run_with_timeout "$GOG_TIMEOUT_SECONDS" gog auth keyring file --plain)"
KEYRING_RC=$?
if [[ "$KEYRING_RC" -eq 124 ]]; then
  echo "status=ERROR"
  echo "reason=KEYRING_TIMEOUT"
  exit 3
fi
if [[ "$KEYRING_RC" -ne 0 ]]; then
  echo "status=ERROR"
  echo "reason=KEYRING_FAILED"
  echo "detail=$(echo "$KEYRING_OUTPUT" | tr '\n' ' ' | sed 's/  */ /g')"
  exit 3
fi

AUTH_LIST="$(run_with_timeout "$GOG_TIMEOUT_SECONDS" gog auth list --plain)"
AUTH_LIST_RC=$?
if [[ "$AUTH_LIST_RC" -eq 124 ]]; then
  echo "status=ERROR"
  echo "reason=AUTH_LIST_TIMEOUT"
  exit 3
fi
if [[ "$AUTH_LIST_RC" -ne 0 ]]; then
  if echo "$AUTH_LIST" | grep -q "no TTY available for keyring file backend password prompt"; then
    echo "status=LOCKED_KEYRING"
    echo "reason=PASSWORD_REQUIRED"
    if [[ "$MODE" == "--check-only" ]]; then
      echo "action=CHECK_ONLY"
      exit 0
    fi
    echo "action=SET_GOG_KEYRING_PASSWORD_OR_RUN_IN_TTY"
    exit 4
  fi
  echo "status=ERROR"
  echo "reason=AUTH_LIST_FAILED"
  echo "detail=$(echo "$AUTH_LIST" | tr '\n' ' ' | sed 's/  */ /g')"
  exit 3
fi
if [[ -z "$AUTH_LIST" ]] || echo "$AUTH_LIST" | grep -q "No tokens stored"; then
  echo "status=MISSING_TOKEN"
  echo "email=$EMAIL"
  echo "services=$SERVICES"
  if [[ "$MODE" == "--check-only" ]]; then
    echo "action=CHECK_ONLY"
    exit 1
  fi
  echo "action=LOGIN_REQUIRED"
  gog login "$EMAIL" --services="$SERVICES"
else
  echo "status=OK"
  echo "action=NONE"
  echo "accounts=$(echo "$AUTH_LIST" | tr '\n' ';' | sed 's/;*$//')"
fi
