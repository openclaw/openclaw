#!/usr/bin/env bash
set -euo pipefail

# Work profile switcher for trusted local sessions.
# Keep platinumfang-mode.sh safe for inbound/untrusted workflows.

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

run_cli() {
  docker compose run --rm openclaw-cli "$@"
}

usage() {
  cat <<'EOF'
Usage: scripts/platinumfang-work.sh <command>

Commands:
  safe          Return to hardened Platinum Fang safe mode
  coding        Trusted local coding mode (Codex/Claude workflow)
  media         Trusted local media mode (video/editing automation)
  social        Trusted local social mode (browser/web posting tasks)
  freeroam      Broad trusted local mode for on-the-fly directives
  status        Show key active settings
  help          Show this help

Notes:
  - These profiles are for trusted local operator sessions.
  - Keep inbound Discord/public-facing workflows on "safe".
EOF
}

set_core_safety() {
  run_cli config set gateway.mode local
  run_cli config set gateway.bind loopback
  run_cli config set session.dmScope per-channel-peer
  run_cli config set tools.elevated.enabled false --json
  run_cli config set agents.defaults.sandbox.mode all
}

profile_coding() {
  set_core_safety
  run_cli config set channels.discord.enabled false --json
  run_cli config set tools.profile coding
  run_cli config set tools.fs.workspaceOnly true --json
  run_cli config set tools.exec.applyPatch.workspaceOnly true --json
  run_cli config set tools.deny '["gateway","cron","sessions_spawn","sessions_send"]' --strict-json
}

profile_media() {
  set_core_safety
  run_cli config set channels.discord.enabled false --json
  run_cli config set tools.profile full
  run_cli config set tools.fs.workspaceOnly false --json
  run_cli config set tools.exec.applyPatch.workspaceOnly true --json
  run_cli config set tools.deny '["gateway","cron","sessions_spawn","sessions_send"]' --strict-json
}

profile_social() {
  set_core_safety
  run_cli config set channels.discord.enabled false --json
  run_cli config set tools.profile full
  run_cli config set tools.fs.workspaceOnly true --json
  run_cli config set tools.exec.applyPatch.workspaceOnly true --json
  run_cli config set tools.deny '["gateway","cron","sessions_spawn","sessions_send","group:runtime","group:fs"]' --strict-json
}

profile_freeroam() {
  set_core_safety
  run_cli config set channels.discord.enabled false --json
  run_cli config set tools.profile full
  run_cli config set tools.fs.workspaceOnly false --json
  run_cli config set tools.exec.applyPatch.workspaceOnly false --json
  run_cli config set tools.deny '["gateway","cron","sessions_spawn","sessions_send"]' --strict-json
}

status() {
  run_cli config get gateway.mode || true
  run_cli config get gateway.bind || true
  run_cli config get channels.discord.enabled || true
  run_cli config get tools.profile || true
  run_cli config get tools.elevated.enabled || true
  run_cli config get tools.fs.workspaceOnly || true
  run_cli config get tools.exec.applyPatch.workspaceOnly || true
  run_cli config get agents.defaults.sandbox.mode || true
  run_cli config get tools.deny || true
}

case "${1:-help}" in
  safe)
    "$SCRIPT_DIR/platinumfang-mode.sh" safe
    ;;
  coding)
    profile_coding
    ;;
  media)
    profile_media
    ;;
  social)
    profile_social
    ;;
  freeroam)
    profile_freeroam
    ;;
  status)
    status
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: ${1:-}" >&2
    usage
    exit 1
    ;;
esac
