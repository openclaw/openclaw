#!/usr/bin/env bash
set -u

if command -v git >/dev/null 2>&1; then
  ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [[ -z "${ROOT_DIR:-}" ]]; then
  SCRIPT_PATH="${BASH_SOURCE[0]-}"
  if [[ -z "${SCRIPT_PATH}" ]]; then
    SCRIPT_PATH="${0}"
  fi
  if [[ -f "$SCRIPT_PATH" ]]; then
    ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
  else
    ROOT_DIR="$(pwd)"
  fi
fi

if [[ -n "${OPENCLAW_CMD:-}" ]]; then
  : # Keep explicit command override from OPENCLAW_CMD.
elif command -v pnpm >/dev/null 2>&1; then
  OPENCLAW_CMD="pnpm openclaw"
elif command -v bun >/dev/null 2>&1; then
  OPENCLAW_CMD="bun run openclaw"
else
  OPENCLAW_CMD="node scripts/run-node.mjs"
fi

: "${OPENCLAW_ONBOARD_HOME:=/tmp/openclaw-onboard-nostr}"
OPENCLAW_ONBOARD_HOME="${OPENCLAW_ONBOARD_HOME%/}"
if [[ -z "${OPENCLAW_ONBOARD_HOME}" ]]; then
  OPENCLAW_ONBOARD_HOME="$(mktemp -d /tmp/openclaw-onboard-nostr.XXXXXX)"
fi

: "${OPENCLAW_NOSTR_PLUGIN_PATH:=extensions/nostr}"
: "${OPENCLAW_NOSTR_RELAYS:=[\"wss://relay.damus.io\",\"wss://relay.primal.net\",\"wss://nostr.wine\"]}"

generate_random_nostr_private_key() {
  local generated=""
  if command -v openssl >/dev/null 2>&1; then
    generated="$(openssl rand -hex 32)"
  fi
  if [[ -z "$generated" ]] && command -v node >/dev/null 2>&1; then
    generated="$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"));' 2>/dev/null || true)"
  fi
  if [[ -z "$generated" ]]; then
    generated="$(LC_CTYPE=C tr -dc '0-9a-f' < /dev/urandom | head -c 64)"
  fi
  printf '%s' "$generated"
}

if [[ -z "${OPENCLAW_NOSTR_PRIVATE_KEY:-}" ]]; then
  OPENCLAW_NOSTR_PRIVATE_KEY="$(generate_random_nostr_private_key)"
fi

if [[ -z "${OPENCLAW_NOSTR_PRIVATE_KEY:-}" ]]; then
  OPENCLAW_NOSTR_PRIVATE_KEY="0000000000000000000000000000000000000000000000000000000000000000"
fi

if [[ ! "$OPENCLAW_NOSTR_PRIVATE_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "Invalid OPENCLAW_NOSTR_PRIVATE_KEY ($OPENCLAW_NOSTR_PRIVATE_KEY); generating a new throwaway key." >&2
  OPENCLAW_NOSTR_PRIVATE_KEY="$(generate_random_nostr_private_key)"
fi
if [[ ! "$OPENCLAW_NOSTR_PRIVATE_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  OPENCLAW_NOSTR_PRIVATE_KEY="$(printf '%064s' "$OPENCLAW_NOSTR_PRIVATE_KEY" | tr ' ' '0')"
  if [[ ${#OPENCLAW_NOSTR_PRIVATE_KEY} -gt 64 ]]; then
    OPENCLAW_NOSTR_PRIVATE_KEY="${OPENCLAW_NOSTR_PRIVATE_KEY:0:64}"
  fi
  OPENCLAW_NOSTR_PRIVATE_KEY="$(printf '%064s' "$OPENCLAW_NOSTR_PRIVATE_KEY" | tr ' ' '0')"
  OPENCLAW_NOSTR_PRIVATE_KEY="$(echo "$OPENCLAW_NOSTR_PRIVATE_KEY" | tr -cd '0-9a-fA-F' | tr 'A-F' 'a-f')"
  OPENCLAW_NOSTR_PRIVATE_KEY="${OPENCLAW_NOSTR_PRIVATE_KEY:0:64}"
fi

OPENCLAW_NOSTR_PRIVATE_KEY="$(echo "$OPENCLAW_NOSTR_PRIVATE_KEY" | tr 'A-F' 'a-f')"
OPENCLAW_NOSTR_PUBLIC_KEY=""

NOSTR_TOOLS_PATH="$ROOT_DIR/extensions/nostr/node_modules/nostr-tools/lib/cjs/index.js"
if [[ -f "$NOSTR_TOOLS_PATH" ]] && command -v node >/dev/null 2>&1; then
  if derived_public="$(
    OPENCLAW_TOOLS_PATH="$NOSTR_TOOLS_PATH" \
    OPENCLAW_NOSTR_PRIVATE_KEY="$OPENCLAW_NOSTR_PRIVATE_KEY" \
      node -e 'const nt = require(process.env.OPENCLAW_TOOLS_PATH); const pub = nt.getPublicKey(nt.utils.hexToBytes(process.env.OPENCLAW_NOSTR_PRIVATE_KEY)); process.stdout.write(pub);'
  )"; then
    OPENCLAW_NOSTR_PUBLIC_KEY="${derived_public:-}"
  else
    OPENCLAW_NOSTR_PUBLIC_KEY=""
  fi
fi

export OPENCLAW_ONBOARD_HOME
export OPENCLAW_NOSTR_PLUGIN_PATH
export OPENCLAW_NOSTR_RELAYS
export OPENCLAW_NOSTR_PRIVATE_KEY
export OPENCLAW_CMD
if [[ -n "${OPENCLAW_NOSTR_PUBLIC_KEY}" ]]; then
  export OPENCLAW_NOSTR_PUBLIC_KEY
fi

if [[ "${SCRIPT_PATH:-$0}" == "$0" ]]; then
  echo "For persistent values in your shell, run:"
  echo "source scripts/dev/onboard-nostr-env.sh"
  echo
fi

cat <<EOF
OpenClaw Nostr onboarding defaults:
  OPENCLAW_ONBOARD_HOME=$OPENCLAW_ONBOARD_HOME
  OPENCLAW_NOSTR_PLUGIN_PATH=$OPENCLAW_NOSTR_PLUGIN_PATH
  OPENCLAW_NOSTR_RELAYS=$OPENCLAW_NOSTR_RELAYS
  OPENCLAW_NOSTR_PRIVATE_KEY=$OPENCLAW_NOSTR_PRIVATE_KEY
  OPENCLAW_CMD=${OPENCLAW_CMD:-pnpm openclaw}

Throwaway key pair (test only):
  Private: $OPENCLAW_NOSTR_PRIVATE_KEY
  Public: ${OPENCLAW_NOSTR_PUBLIC_KEY:-not available (install extension deps to derive)}

Run:
  source scripts/dev/onboard-nostr-env.sh && scripts/dev/onboard-session.sh nostr
EOF
