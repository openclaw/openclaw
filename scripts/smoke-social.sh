#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cleanup() { rm -f /tmp/smoke-social-*.txt /tmp/smoke-social-*.json /tmp/smoke-social-*.out /tmp/smoke-social-*.err /tmp/smoke-social-*.yaml; }
trap cleanup EXIT

WITH_LIVE=0
WITH_DOCKER=0

usage() {
  cat <<'USAGE'
Smoke test for social workflow (twitter-openclaw / twclaw only).

Usage:
  scripts/smoke-social.sh [--with-live] [--with-docker]

Options:
  --with-live    Run live Twitter API checks when token is present.
  --with-docker  Validate docker-compose interpolation/config for gateway.
  -h, --help     Show this help.

Environment (optional for --with-live):
  TWITTER_BEARER_TOKEN
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-live)
      WITH_LIVE=1
      ;;
    --with-docker)
      WITH_DOCKER=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '[smoke-social] %s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 2
  fi
}

need_file() {
  if [[ ! -f "$1" ]]; then
    echo "Missing required file: $1" >&2
    exit 2
  fi
}

parse_json_file() {
  node -e 'const fs=require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1],"utf8"));' "$1"
}

need_cmd node

TWC_ROOT="skills/twitter-openclaw"
TWC_WS="workspace/skills/twitter-openclaw"

need_file "$TWC_ROOT/bin/twclaw.js"
need_file "$TWC_WS/bin/twclaw.js"

log "Checking twclaw CLI shape and Node syntax"
node --check "$TWC_WS/bin/twclaw.js"
node "$TWC_WS/bin/twclaw.js" --help >/tmp/smoke-social-twclaw-help.txt
grep -q 'twclaw search "query"' /tmp/smoke-social-twclaw-help.txt
grep -q -- '--popular' /tmp/smoke-social-twclaw-help.txt

log "Checking write safety guard (non-interactive mode should block without --yes)"
if node "$TWC_WS/bin/twclaw.js" reply 123 "smoke check" >/tmp/smoke-social-write.out 2>/tmp/smoke-social-write.err; then
  echo "Write safety check failed: command unexpectedly succeeded" >&2
  exit 1
fi
grep -qi "non-interactive mode" /tmp/smoke-social-write.err

log "Checking workspace policy docs"
grep -q 'twclaw' workspace/TOOLS.md
grep -q 'twclaw' workspace/HEARTBEAT.md
grep -q 'twclaw API' workspace/AGENTS.md

if [[ "$WITH_LIVE" -eq 1 ]]; then
  log "Running live checks"

  if [[ -n "${TWITTER_BEARER_TOKEN:-}" ]]; then
    node "$TWC_WS/bin/twclaw.js" auth-check >/tmp/smoke-social-tw-auth.json
    parse_json_file /tmp/smoke-social-tw-auth.json

    node "$TWC_WS/bin/twclaw.js" search "(ERC8004 OR ERC-8004) lang:en -is:retweet" -n 10 --popular --json >/tmp/smoke-social-tw-search.json
    parse_json_file /tmp/smoke-social-tw-search.json
    log "Live Twitter check OK"
  else
    log "Skipping live Twitter check (TWITTER_BEARER_TOKEN not set)"
  fi
fi

if [[ "$WITH_DOCKER" -eq 1 ]]; then
  need_cmd docker
  log "Validating docker-compose config"
  OPENCLAW_GATEWAY_TOKEN=dummy \
  OPENAI_API_KEY=dummy \
  OPENROUTER_API_KEY=dummy \
  TELEGRAM_BOT_TOKEN=dummy \
  TYPEFULLY_API_KEY=dummy \
  TWITTER_BEARER_TOKEN=dummy \
  TWITTER_API_KEY=dummy \
  TWITTER_API_SECRET=dummy \
  docker compose config >/tmp/smoke-social-compose.yaml

  grep -q '\$\$daily_date' docker-compose.yml
  grep -q '\$\$daily_dir' docker-compose.yml
  log "Docker compose check OK"
fi

log "Smoke test passed"
