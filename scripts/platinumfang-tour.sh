#!/usr/bin/env bash
set -euo pipefail

# Platinum Fang visual tour + capability explainer.
# Read-only helper for operators.

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

hr() { printf '%*s\n' "${COLUMNS:-80}" '' | tr ' ' '-'; }
title() { hr; printf "%s\n" "$1"; hr; }
run_cli() { docker compose run --rm openclaw-cli "$@"; }

title "Platinum Fang: Architecture (Visual)"
cat <<'EOF'
Discord DM / Guild
        |
        v
  +------------------+
  | Gateway (Docker) |
  | openclaw-gateway |
  +------------------+
        |
        v
  +------------------+         +----------------------+
  | Agent Runtime    |-------> | Tools Policy/Sandbox |
  +------------------+         +----------------------+
        |
        +--> Local model (Ollama)
        +--> Cloud fallback (OpenRouter)
EOF

title "Platinum Fang: Mode Semantics"
cat <<'EOF'
safe:
  - Strict tools profile
  - Mention required in guild
  - Local-first model chain
  - Deep security audit

power:
  - More permissive tools profile
  - Mention optional in guild
  - Cloud-first model chain

off:
  - Stops all containers
EOF

title "Live Runtime Status"
docker compose ps || true

title "Live Policy Snapshot"
run_cli config get channels.discord.enabled || true
run_cli config get channels.discord.dmPolicy || true
run_cli config get channels.discord.guilds || true
run_cli config get session.dmScope || true
run_cli config get tools.profile || true
run_cli config get tools.deny || true
run_cli config get agents.defaults.model || true

title "Command Palette"
cat <<'EOF'
scripts/platinumfang-mode.sh safe
scripts/platinumfang-mode.sh power
scripts/platinumfang-mode.sh status
scripts/platinumfang-mode.sh off
scripts/platinumfang-mode.sh mention-on
scripts/platinumfang-mode.sh mention-off
scripts/platinumfang-mode.sh mention-toggle
scripts/platinumfang-mode.sh local-only
scripts/platinumfang-mode.sh cloud-only
scripts/platinumfang-mode.sh model-toggle
scripts/platinumfang-mode.sh discord-on
scripts/platinumfang-mode.sh discord-off
scripts/platinumfang-mode.sh discord-toggle
scripts/platinumfang-mode.sh profile-toggle
scripts/platinumfang-mode.sh toggle-all
scripts/platinumfang-setup.sh
EOF
