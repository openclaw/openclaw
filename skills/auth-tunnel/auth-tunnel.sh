#!/usr/bin/env bash
#
# auth-tunnel — Secure browser-based auth via Tailscale Funnel
#
# Opens a headless Chromium on the server, exposes it via noVNC + Tailscale Funnel.
# User logs in directly (credentials never leave HTTPS to the target service).
# After login, cookies are extracted via Chrome DevTools Protocol (CDP).
#
# Usage: auth-tunnel.sh <url> [--port 8443] [--extract-cookies domain1,domain2]
#
# Dependencies: Xvfb, chromium-browser, x11vnc, websockify, noVNC, tailscale, curl, jq

set -euo pipefail

# --- Defaults ---
URL=""
FUNNEL_PORT=8443
NOVNC_PORT=6080
VNC_PORT=5900
CDP_PORT=9222
DISPLAY_NUM=99
EXTRACT_DOMAINS=""
COOKIE_OUTPUT="cookies.json"
RESOLUTION="1280x800x24"
CLEANUP_PIDS=()

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) FUNNEL_PORT="$2"; shift 2 ;;
    --extract-cookies) EXTRACT_DOMAINS="$2"; shift 2 ;;
    --output) COOKIE_OUTPUT="$2"; shift 2 ;;
    --resolution) RESOLUTION="$2"; shift 2 ;;
    --vnc-port) VNC_PORT="$2"; shift 2 ;;
    --novnc-port) NOVNC_PORT="$2"; shift 2 ;;
    --cdp-port) CDP_PORT="$2"; shift 2 ;;
    --display) DISPLAY_NUM="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: auth-tunnel.sh <url> [options]"
      echo ""
      echo "Options:"
      echo "  --port PORT            Tailscale funnel port (default: 8443)"
      echo "  --extract-cookies d1,d2  Comma-separated domains to extract cookies from"
      echo "  --output FILE          Cookie output file (default: cookies.json)"
      echo "  --resolution WxHxD     Screen resolution (default: 1280x800x24)"
      echo "  --vnc-port PORT        VNC port (default: 5900)"
      echo "  --novnc-port PORT      noVNC websockify port (default: 6080)"
      echo "  --cdp-port PORT        Chrome DevTools Protocol port (default: 9222)"
      echo "  --display NUM          X display number (default: 99)"
      exit 0
      ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) URL="$1"; shift ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "Error: URL is required" >&2
  echo "Usage: auth-tunnel.sh <url> [--extract-cookies domain1,domain2]" >&2
  exit 1
fi

# --- Cleanup on exit ---
cleanup() {
  echo ""
  echo "🧹 Cleaning up..."
  
  # Kill all tracked processes
  for pid in "${CLEANUP_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  
  # Stop tailscale funnel
  tailscale funnel --https="$FUNNEL_PORT" off 2>/dev/null || true
  
  # Remove temporary chrome profile
  if [[ -n "${CHROME_PROFILE:-}" && -d "$CHROME_PROFILE" ]]; then
    rm -rf "$CHROME_PROFILE"
  fi
  
  echo "✅ Cleaned up"
}
trap cleanup EXIT INT TERM

# --- Check dependencies ---
for cmd in Xvfb chromium-browser x11vnc websockify tailscale curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd not found" >&2
    exit 1
  fi
done

# --- Start Xvfb ---
echo "🖥️  Starting virtual display :${DISPLAY_NUM}..."
Xvfb ":${DISPLAY_NUM}" -screen 0 "$RESOLUTION" -ac &
CLEANUP_PIDS+=($!)
sleep 1

export DISPLAY=":${DISPLAY_NUM}"

# --- Start Chromium with CDP ---
CHROME_PROFILE=$(mktemp -d /tmp/auth-tunnel-chrome.XXXXXX)
echo "🌐 Starting Chromium → $URL"
chromium-browser \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir="$CHROME_PROFILE" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --window-size=1280,800 \
  --start-maximized \
  "$URL" &
CLEANUP_PIDS+=($!)
sleep 2

# --- Start x11vnc ---
echo "📡 Starting VNC server on port $VNC_PORT..."
x11vnc -display ":${DISPLAY_NUM}" -rfbport "$VNC_PORT" -nopw -forever -shared -quiet &
CLEANUP_PIDS+=($!)
sleep 1

# --- Start noVNC via websockify ---
echo "🌍 Starting noVNC on port $NOVNC_PORT..."
websockify --web=/usr/share/novnc "$NOVNC_PORT" "localhost:$VNC_PORT" &
CLEANUP_PIDS+=($!)
sleep 1

# --- Start Tailscale Funnel ---
echo "🔗 Starting Tailscale Funnel on port $FUNNEL_PORT..."
tailscale funnel --https="$FUNNEL_PORT" --bg "http://localhost:$NOVNC_PORT" 2>/dev/null

# Get the funnel URL
HOSTNAME=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
FUNNEL_URL="https://${HOSTNAME}:${FUNNEL_PORT}/vnc_lite.html?autoconnect=true&resize=remote"

echo ""
echo "════════════════════════════════════════════════"
echo "🔐 Auth Tunnel Ready!"
echo ""
echo "   $FUNNEL_URL"
echo ""
echo "   Open this link, log in to the service."
echo "   Your credentials go directly to $URL"
echo "   (never through this server or any chat)."
echo ""
echo "   Press ENTER when you're done logging in."
echo "════════════════════════════════════════════════"
echo ""

# --- Wait for user ---
read -r -p "⏳ Waiting... Press ENTER after login is complete: "

# --- Extract cookies via CDP ---
if [[ -n "$EXTRACT_DOMAINS" ]]; then
  echo ""
  echo "🍪 Extracting cookies..."
  
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  
  NODE_PATH="${NODE_PATH:-$HOME/openclaw/node_modules}" \
    node "$SCRIPT_DIR/extract-cookies.cjs" "$CDP_PORT" "$EXTRACT_DOMAINS" "$COOKIE_OUTPUT"
else
  echo "ℹ️  No --extract-cookies specified, skipping cookie extraction"
fi

echo ""
echo "🏁 Done! Shutting down tunnel..."
