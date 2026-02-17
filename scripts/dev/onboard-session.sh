#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -n "${OPENCLAW_CMD:-}" ]]; then
  : # Keep explicit command override from OPENCLAW_CMD.
elif command -v pnpm >/dev/null 2>&1; then
  OPENCLAW_CMD="pnpm openclaw"
elif command -v bun >/dev/null 2>&1; then
  OPENCLAW_CMD="bun run openclaw"
else
  OPENCLAW_CMD="node scripts/run-node.mjs"
fi
NOSTR_PLUGIN_PATH="${OPENCLAW_NOSTR_PLUGIN_PATH:-extensions/nostr}"
NOSTR_RELAYS="${OPENCLAW_NOSTR_RELAYS:-[\"wss://relay.damus.io\",\"wss://relay.primal.net\",\"wss://relay.wine\"]}"
NOSTR_PRIVATE_KEY="${OPENCLAW_NOSTR_PRIVATE_KEY:-}"
read -r -a OPENCLAW_CMD_ARR <<< "$OPENCLAW_CMD"

run_openclaw() {
  (cd "$ROOT_DIR" && "${OPENCLAW_CMD_ARR[@]}" "$@")
}

run_quickstart() {
  run_openclaw onboard \
    --accept-risk \
    --flow quickstart \
    --mode local \
    --skip-channels \
    --skip-skills \
    --skip-daemon \
    --skip-ui \
    --skip-health \
    --auth-choice skip
}

usage() {
  cat <<'USAGE'
Usage: scripts/dev/onboard-session.sh [mode]

Modes:
  quickstart          Non-interactive quickstart setup, skipping channels/skills/ui/health
  configure-channels  Run channel wizard in an existing or fresh session
  all                 quickstart setup, then launch channel configure wizard
  nostr               Full Nostr setup (quickstart + plugin install + direct channel config)
  cleanup             Remove temporary HOME directories created by this script

Environment:
  OPENCLAW_ONBOARD_HOME     Optional fixed HOME dir (defaults to new /tmp/openclaw-onboard.*)
  KEEP_OPENCLAW_HOME        Set to 1 to keep temp HOME after completion
  OPENCLAW_NOSTR_PLUGIN_PATH Path to Nostr plugin (default: extensions/nostr)
  OPENCLAW_NOSTR_RELAYS      JSON array string for Nostr relays
  OPENCLAW_NOSTR_PRIVATE_KEY  Required for nostr mode

Examples:
  scripts/dev/onboard-session.sh quickstart
  scripts/dev/onboard-session.sh configure-channels
  OPENCLAW_NOSTR_PRIVATE_KEY=abc123 scripts/dev/onboard-session.sh nostr
  OPENCLAW_ONBOARD_HOME=/tmp/oc-home scripts/dev/onboard-session.sh all
USAGE
}

case "${1:-quickstart}" in
  -h|--help|help)
    usage
    exit 0
    ;;
  quickstart|configure-channels|all|nostr|cleanup)
    MODE="$1"
    ;;
  *)
    echo "Unknown mode: ${1:-}" >&2
    usage
    exit 2
    ;;
esac

if [[ "${MODE}" == "cleanup" ]]; then
  rm -rf /tmp/openclaw-onboard.*
  rm -rf /tmp/openclaw-channels.*
  echo "Cleaned temporary onboard homes under /tmp."
  exit 0
fi

HOME_DIR="${OPENCLAW_ONBOARD_HOME:-$(mktemp -d /tmp/openclaw-onboard.XXXXXX)}"
export HOME="$HOME_DIR"

if [[ "${MODE}" == "quickstart" || "${MODE}" == "all" ]]; then
  run_quickstart
fi

if [[ "${MODE}" == "configure-channels" || "${MODE}" == "all" ]]; then
  if [[ ! -f "$HOME/.openclaw/openclaw.json" ]]; then
    echo "No config found at $HOME/.openclaw/openclaw.json"
    echo "Run: scripts/dev/onboard-session.sh quickstart first, then re-run with configure-channels"
    exit 1
  fi
  run_openclaw configure --section channels
fi

if [[ "${MODE}" == "nostr" ]]; then
  if [[ ! -f "$HOME/.openclaw/openclaw.json" ]]; then
    run_quickstart
  fi

  run_openclaw plugins install --link "$NOSTR_PLUGIN_PATH"

  if [[ -z "$NOSTR_PRIVATE_KEY" ]]; then
    echo "Nostr private key missing."
    echo "Set OPENCLAW_NOSTR_PRIVATE_KEY and retry."
    exit 1
  fi

  run_openclaw config set channels.nostr.privateKey "$NOSTR_PRIVATE_KEY"
  run_openclaw config set --json channels.nostr.relays "$NOSTR_RELAYS"
  run_openclaw config set channels.nostr.enabled true
  run_openclaw channels status --probe
fi

echo "onboarding HOME: $HOME_DIR"
if [[ "${KEEP_OPENCLAW_HOME:-0}" != "1" ]]; then
  echo "Set KEEP_OPENCLAW_HOME=1 to reuse this HOME for manual inspection."
fi
