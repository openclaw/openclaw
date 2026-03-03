#!/usr/bin/env bash
# signal-relink.sh — re-link signal-cli to your Signal account via QR code
#
# When to use: signal-check.sh reports "device not linked", or accounts.json is empty
#
# Steps:
#   1. Generates a link URI from signal-cli
#   2. Opens a QR code in your browser
#   3. You scan it: Signal app → Settings → Linked Devices → Link New Device
#   4. On success: restarts the daemon and backs up account data
#
# Usage: bash scripts/signal-relink.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.safe"

# Safe env reader — grep-based so paths with spaces in .env.safe don't break bash
get_env() {
  local key="$1" default="${2:-}"
  local val
  val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  echo "${val:-$default}"
}

SIGNAL_CLI_DATA_DIR=$(get_env SIGNAL_CLI_DATA_DIR "/Volumes/Crucial Deez X9 Pro/openclaw_safe_live/config/signal-cli")
QR_PKG_DIR="/tmp/mb-signal-qr"
QR_NODE="${QR_PKG_DIR}/node_modules/qrcode"

echo ""
echo "━━━ Signal Re-Link ━━━"
echo ""

# ── Warn if already linked ────────────────────────────────────────────────────

EXISTING_DB=$(find "${SIGNAL_CLI_DATA_DIR}/data" -name 'account.db' -maxdepth 2 2>/dev/null | head -1 || true)
if [ -n "$EXISTING_DB" ]; then
  echo "⚠️  A Signal account is already linked on this device."
  echo "   Proceeding will add a new secondary device link to your Signal account."
  echo "   The existing link stays intact. Your Signal app will show both devices."
  echo ""
  read -rp "Continue? [y/N] " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
  echo ""
fi

# ── Ensure qrcode npm package ─────────────────────────────────────────────────

if [ ! -f "${QR_NODE}/package.json" ]; then
  echo "Installing qrcode npm package (one-time)..."
  mkdir -p "$QR_PKG_DIR"
  npm install --prefix "$QR_PKG_DIR" qrcode --save-dev --quiet 2>/dev/null
  echo "Done."
fi

# ── Stop daemon so link session can use the data dir ─────────────────────────

echo "Stopping signal-cli daemon (if running)..."
docker stop openclaw-signal 2>/dev/null && sleep 1 || true

# ── Start temporary link session ──────────────────────────────────────────────

echo "Starting link session..."
docker rm -f signal-linker 2>/dev/null || true

docker run -d --name signal-linker \
  -e JAVA_TOOL_OPTIONS="-Dorg.sqlite.lib.exportPath=/tmp" \
  -v "${SIGNAL_CLI_DATA_DIR}:/home/.local/share/signal-cli" \
  --entrypoint signal-cli \
  bbernhard/signal-cli-rest-api:latest \
  --config /home/.local/share/signal-cli \
  link --name "MaxBot" > /dev/null

echo "Waiting for link URI..."
URI=""
for i in $(seq 1 15); do
  URI=$(docker logs signal-linker 2>&1 | grep '^sgnl://' | head -1 || true)
  [ -n "$URI" ] && break
  sleep 1
done

if [ -z "$URI" ]; then
  echo "ERROR: Timed out waiting for link URI. Check: docker logs signal-linker" >&2
  docker rm -f signal-linker 2>/dev/null || true
  exit 1
fi

# ── Render QR code and open browser ──────────────────────────────────────────

node -e "
const QRCode = require('${QR_NODE}');
const uri = process.argv[1];
QRCode.toDataURL(uri, {scale: 8, margin: 2}, (err, dataUrl) => {
  if (err) { console.error(err); process.exit(1); }
  const html = \`<!DOCTYPE html>
<html>
<head>
  <title>Scan to Link MaxBot — Signal</title>
  <style>
    body {
      background: #0a0a0a;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; margin: 0;
    }
    h2  { margin-bottom: 8px; font-size: 22px; }
    .sub { color: #888; font-size: 14px; margin-bottom: 28px; }
    img  { border: 18px solid #fff; border-radius: 14px; max-width: 440px; display: block; }
    .note { margin-top: 20px; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <h2>Scan to Link MaxBot</h2>
  <p class=\"sub\">Signal → Settings → Linked Devices → Link New Device → point camera here</p>
  <img src=\"\${dataUrl}\" width=\"440\" height=\"440\" />
  <p class=\"note\">This QR expires in ~90 seconds. Close after scanning.</p>
</body>
</html>\`;
  require('fs').writeFileSync('/tmp/signal-link-qr.html', html);
});
" "$URI"

open /tmp/signal-link-qr.html

echo ""
echo "📱 QR code opened in your browser."
echo "   Open Signal → Settings → Linked Devices → Link New Device → scan QR"
echo "   You have ~90 seconds."
echo ""

# ── Wait for signal-cli to confirm the link ───────────────────────────────────

docker wait signal-linker > /dev/null 2>&1 || true
EXIT_CODE=$(docker inspect signal-linker --format '{{.State.ExitCode}}' 2>/dev/null || echo "1")
docker rm -f signal-linker 2>/dev/null || true

if [ "$EXIT_CODE" != "0" ]; then
  echo "❌ Linking failed or timed out (signal-cli exit code: ${EXIT_CODE})"
  echo "   Try running this script again and scan within 90 seconds."
  # Restart daemon so system isn't left stopped
  docker compose --env-file "$ENV_FILE" up -d signal-cli 2>/dev/null || \
    docker start openclaw-signal 2>/dev/null || true
  exit 1
fi

echo "✅ Device linked successfully!"

# ── Backup and restart ────────────────────────────────────────────────────────

echo ""
bash "${SCRIPT_DIR}/signal-backup.sh"

echo ""
echo "Restarting signal-cli daemon..."
docker compose --env-file "$ENV_FILE" up -d signal-cli 2>/dev/null || \
  docker start openclaw-signal 2>/dev/null || true

sleep 6

echo ""
bash "${SCRIPT_DIR}/signal-check.sh" || true

echo ""
echo "━━━ Done ━━━"
echo "Gateway will reconnect to Signal automatically within ~10 seconds."
