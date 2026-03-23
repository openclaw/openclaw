#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_HOME=$(mktemp -d)
trap 'rm -rf "$TMP_HOME"' EXIT

EXPECTED_TZ=$(node -e 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")')
LOCAL_WS="$TMP_HOME/local-workspace"
REMOTE_URL="wss://example.com:18789"

run_onboard() {
  OPENCLAW_HOME="$TMP_HOME" \
  HOME="$TMP_HOME" \
  node "$ROOT/openclaw.mjs" onboard "$@"
}

read_user_timezone() {
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
    process.stdout.write(cfg?.agents?.defaults?.userTimezone || "");
  ' "$TMP_HOME/.openclaw/openclaw.json"
}

assert_timezone() {
  local actual="$1"
  local label="$2"
  if [[ "$actual" != "$EXPECTED_TZ" ]]; then
    echo "[$label] expected userTimezone=$EXPECTED_TZ but got: ${actual:-<unset>}" >&2
    exit 1
  fi
}

echo "== local onboard smoke =="
run_onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice skip \
  --skip-health \
  --skip-channels \
  --skip-skills \
  --skip-search \
  --workspace "$LOCAL_WS"

LOCAL_TZ=$(read_user_timezone)
assert_timezone "$LOCAL_TZ" "local"
echo "local userTimezone: $LOCAL_TZ"

echo "== remote onboard smoke =="
run_onboard \
  --non-interactive \
  --accept-risk \
  --mode remote \
  --remote-url "$REMOTE_URL" \
  --skip-health

REMOTE_TZ=$(read_user_timezone)
assert_timezone "$REMOTE_TZ" "remote"
echo "remote userTimezone: $REMOTE_TZ"

echo "smoke ok"
