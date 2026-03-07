#!/usr/bin/env bash
set -euo pipefail

# Platinum Fang automated secure setup.
# This script applies hardened defaults and optionally sets the Discord bot token.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose v2 is required." >&2
  exit 1
fi

DISCORD_SERVER_ID="${DISCORD_SERVER_ID:-1478877509285318656}"
DISCORD_USER_ID="${DISCORD_USER_ID:-1143280146435027108}"
SET_TOKEN="${SET_TOKEN:-0}"
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"

run_cli() {
  docker compose run --rm openclaw-cli "$@"
}

print_step() {
  printf "\n[Platinum Fang] %s\n" "$1"
}

print_step "Starting gateway container"
docker compose up -d openclaw-gateway

print_step "Applying Discord channel baseline"
run_cli config set channels.discord.enabled true --json
run_cli config set channels.discord.dmPolicy pairing
run_cli config set channels.discord.groupPolicy allowlist
run_cli config set channels.discord.guilds "{\"$DISCORD_SERVER_ID\":{\"requireMention\":true,\"users\":[\"$DISCORD_USER_ID\"]}}" --strict-json

if [[ "$SET_TOKEN" == "1" ]]; then
  if [[ -z "$DISCORD_BOT_TOKEN" ]]; then
    echo "SET_TOKEN=1 requires DISCORD_BOT_TOKEN." >&2
    exit 1
  fi
  print_step "Setting Discord bot token"
  run_cli config set channels.discord.token "\"$DISCORD_BOT_TOKEN\"" --json
else
  print_step "Skipping token update (SET_TOKEN=0)"
fi

print_step "Applying secure runtime policy"
run_cli config set gateway.mode local
run_cli config set gateway.bind loopback
run_cli config set session.dmScope per-channel-peer
run_cli config set tools.profile messaging
run_cli config set tools.deny '["gateway","cron","sessions_spawn","sessions_send","group:runtime","group:fs","group:automation"]' --strict-json
run_cli config set tools.elevated.enabled false --json
run_cli config set tools.fs.workspaceOnly true --json
run_cli config set tools.exec.applyPatch.workspaceOnly true --json

print_step "Applying Platinum Fang safe mode model/profile chain"
"$SCRIPT_DIR/platinumfang-mode.sh" safe

print_step "Running deep security audit"
run_cli security audit --deep

print_step "Done"
echo "Next: DM your bot on Discord, then approve pairing code:"
echo "  docker compose run --rm openclaw-cli pairing list discord"
echo "  docker compose run --rm openclaw-cli pairing approve discord <CODE>"
