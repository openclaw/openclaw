#!/usr/bin/env bash
# Run Codex (ChatGPT) OAuth against the mounted ~/.openclaw config.
# Requires an interactive TTY: paste the redirect URL when prompted.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
exec docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm \
  openclaw-cli models auth login --provider openai-codex "$@"
