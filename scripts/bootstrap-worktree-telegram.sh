#!/usr/bin/env bash
set -euo pipefail

MAIN_REPO_DEFAULT="/Users/user/Programming_Projects/openclaw"
MAIN_REPO="${OPENCLAW_MAIN_REPO:-$MAIN_REPO_DEFAULT}"

if [[ ! -d "$MAIN_REPO" ]]; then
  echo "Main repo not found: $MAIN_REPO" >&2
  echo "Set OPENCLAW_MAIN_REPO to your main checkout path." >&2
  exit 1
fi

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    if [[ ! -f "$dst" ]] || ! cmp -s "$src" "$dst"; then
      cp "$src" "$dst"
    fi
  fi
}

# Bot token pool for worktree assignment.
copy_if_exists "$MAIN_REPO/.env.bots" "./.env.bots"

has_token_claim() {
  if [[ ! -f "./.env.local" ]]; then
    return 1
  fi
  grep -Eq '^[[:space:]]*TELEGRAM_BOT_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]#]+' "./.env.local"
}

if [[ -f "./.env.bots" ]]; then
  if has_token_claim; then
    echo "skip: existing TELEGRAM_BOT_TOKEN claim found in .env.local"
  else
    bash scripts/assign-bot.sh
  fi
else
  echo "skip: .env.bots missing in main repo"
fi

# Prepare deterministic lane metadata for live Telegram E2E.
if [[ -x "./scripts/telegram-e2e/lane-up.sh" ]]; then
  if ! bash ./scripts/telegram-e2e/lane-up.sh --prepare-only >/dev/null; then
    echo "skip: lane metadata preparation failed"
  fi
fi

# Optional userbot E2E files for true inbound Telegram verification.
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env" "./scripts/telegram-e2e/.env"
copy_if_exists "$MAIN_REPO/scripts/telegram-e2e/.env.local" "./scripts/telegram-e2e/.env.local"
if [[ -f "$MAIN_REPO/scripts/telegram-e2e/tmp/userbot.session" ]]; then
  copy_if_exists \
    "$MAIN_REPO/scripts/telegram-e2e/tmp/userbot.session" \
    "./scripts/telegram-e2e/tmp/userbot.session"
elif [[ -f "$MAIN_REPO/scripts/telegram-e2e/userbot.session" ]]; then
  copy_if_exists \
    "$MAIN_REPO/scripts/telegram-e2e/userbot.session" \
    "./scripts/telegram-e2e/tmp/userbot.session"
fi

echo "telegram bootstrap complete"
