#!/usr/bin/env bash
set -euo pipefail

# Platinum Fang mode switcher for Docker deployments.
# Backed by the same OpenClaw runtime engine.

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
LOCAL_MODEL="${LOCAL_MODEL:-ollama/gpt-oss:20b}"
CLOUD_MODEL_FREE="${CLOUD_MODEL_FREE:-openrouter/z-ai/glm-4.5-air:free}"
CLOUD_MODEL_ROUTER_FREE="${CLOUD_MODEL_ROUTER_FREE:-openrouter/openrouter/free}"
CLOUD_MODEL_PREMIUM="${CLOUD_MODEL_PREMIUM:-openrouter/z-ai/glm-5}"

usage() {
  cat <<'EOF'
Usage: scripts/platinumfang-mode.sh <command>

Core modes:
  safe          Hardened daily mode (recommended default)
  power         More permissive mode for trusted focused work
  off           Stop Platinum Fang containers
  status        Show container + key config status

Switches:
  discord-on    Enable Discord channel
  discord-off   Disable Discord channel
  discord-toggle Toggle Discord enabled state
  mention-on    Require @mention in Discord guild
  mention-off   Allow no-mention replies in Discord guild
  mention-toggle Toggle mention requirement in Discord guild
  local-only    Local model primary + local-only fallback chain
  cloud-only    Cloud model primary + cloud fallback chain
  model-toggle  Toggle model chain between local-only and cloud-only
  profile-toggle Toggle tools.profile between messaging and full
  toggle-all    Toggle Discord, mention, model chain, and tools profile
  help          Show this help

Environment overrides:
  DISCORD_SERVER_ID       Discord guild/server ID
  DISCORD_USER_ID         Your Discord user ID
  LOCAL_MODEL             Default: ollama/gpt-oss:20b
  CLOUD_MODEL_FREE        Default: openrouter/z-ai/glm-4.5-air:free
  CLOUD_MODEL_ROUTER_FREE Default: openrouter/openrouter/free
  CLOUD_MODEL_PREMIUM     Default: openrouter/z-ai/glm-5
EOF
}

run_cli() {
  # Engine command remains openclaw-cli for compatibility.
  docker compose run --rm openclaw-cli "$@"
}

get_value() {
  run_cli config get "$1" 2>/dev/null | tr -d '\r' | tail -n 1
}

set_guild_policy() {
  local require_mention="$1"
  run_cli config set channels.discord.groupPolicy allowlist
  run_cli config set channels.discord.guilds "{\"$DISCORD_SERVER_ID\":{\"requireMention\":$require_mention,\"users\":[\"$DISCORD_USER_ID\"]}}" --strict-json
}

set_model_chain_local_only() {
  run_cli config set agents.defaults.model.primary "$LOCAL_MODEL"
  run_cli config set agents.defaults.model.fallbacks "[\"$LOCAL_MODEL\"]" --strict-json
}

set_model_chain_cloud_only() {
  run_cli config set agents.defaults.model.primary "$CLOUD_MODEL_FREE"
  run_cli config set agents.defaults.model.fallbacks "[\"$CLOUD_MODEL_ROUTER_FREE\",\"$CLOUD_MODEL_PREMIUM\"]" --strict-json
}

set_model_chain_hybrid_safe() {
  run_cli config set agents.defaults.model.primary "$LOCAL_MODEL"
  run_cli config set agents.defaults.model.fallbacks "[\"$CLOUD_MODEL_FREE\",\"$CLOUD_MODEL_ROUTER_FREE\",\"$CLOUD_MODEL_PREMIUM\"]" --strict-json
}

set_model_chain_hybrid_power() {
  run_cli config set agents.defaults.model.primary "$CLOUD_MODEL_FREE"
  run_cli config set agents.defaults.model.fallbacks "[\"$LOCAL_MODEL\",\"$CLOUD_MODEL_ROUTER_FREE\",\"$CLOUD_MODEL_PREMIUM\"]" --strict-json
}

safe_mode() {
  set_model_chain_hybrid_safe
  run_cli config set tools.profile messaging
  run_cli config set tools.deny '["gateway","cron","sessions_spawn","sessions_send","group:runtime","group:fs","group:automation"]' --strict-json
  run_cli config set tools.elevated.enabled false --json
  run_cli config set session.dmScope per-channel-peer
  run_cli config set tools.fs.workspaceOnly true --json
  run_cli config set tools.exec.applyPatch.workspaceOnly true --json
  set_guild_policy true
  docker compose up -d openclaw-gateway
  run_cli security audit --deep
}

power_mode() {
  set_model_chain_hybrid_power
  run_cli config set tools.profile full
  run_cli config set tools.deny '["gateway","cron","sessions_spawn","sessions_send"]' --strict-json
  run_cli config set tools.elevated.enabled false --json
  run_cli config set session.dmScope per-channel-peer
  set_guild_policy false
  docker compose up -d openclaw-gateway
}

status_mode() {
  docker compose ps
  run_cli config get channels.discord.enabled || true
  run_cli config get channels.discord.guilds || true
  run_cli config get agents.defaults.model || true
  run_cli config get tools.profile || true
  run_cli config get tools.deny || true
}

discord_toggle() {
  local current
  current="$(get_value channels.discord.enabled)"
  if [[ "$current" == "true" ]]; then
    run_cli config set channels.discord.enabled false --json
  else
    run_cli config set channels.discord.enabled true --json
  fi
}

mention_toggle() {
  local guilds
  guilds="$(run_cli config get channels.discord.guilds 2>/dev/null | tr -d '\r')"
  if printf '%s' "$guilds" | grep -q '"requireMention":[[:space:]]*true'; then
    set_guild_policy false
  else
    set_guild_policy true
  fi
}

model_toggle() {
  local primary
  primary="$(get_value agents.defaults.model.primary)"
  if printf '%s' "$primary" | grep -q '^ollama/'; then
    set_model_chain_cloud_only
  else
    set_model_chain_local_only
  fi
}

profile_toggle() {
  local current
  current="$(get_value tools.profile)"
  if [[ "$current" == "messaging" ]]; then
    run_cli config set tools.profile full
  else
    run_cli config set tools.profile messaging
  fi
}

toggle_all() {
  discord_toggle
  mention_toggle
  model_toggle
  profile_toggle
  status_mode
}

case "${1:-help}" in
  safe) safe_mode ;;
  power) power_mode ;;
  off) docker compose down ;;
  status) status_mode ;;
  discord-on) run_cli config set channels.discord.enabled true --json ;;
  discord-off) run_cli config set channels.discord.enabled false --json ;;
  discord-toggle) discord_toggle ;;
  mention-on) set_guild_policy true ;;
  mention-off) set_guild_policy false ;;
  mention-toggle) mention_toggle ;;
  local-only) set_model_chain_local_only ;;
  cloud-only) set_model_chain_cloud_only ;;
  model-toggle) model_toggle ;;
  profile-toggle) profile_toggle ;;
  toggle-all) toggle_all ;;
  help|-h|--help) usage ;;
  *)
    echo "Unknown command: ${1:-}" >&2
    usage
    exit 1
    ;;
esac
