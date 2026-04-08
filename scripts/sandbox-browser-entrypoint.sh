#!/usr/bin/env bash
set -euo pipefail

export DBUS_SESSION_BUS_ADDRESS=/dev/null

export DISPLAY=:1
export HOME=/tmp/openclaw-home
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${OPENCLAW_BROWSER_CDP_PORT:-9222}"
CDP_SOURCE_RANGE="${OPENCLAW_BROWSER_CDP_SOURCE_RANGE:-}"
HEADLESS="${OPENCLAW_BROWSER_HEADLESS:-0}"
ALLOW_NO_SANDBOX="${OPENCLAW_BROWSER_NO_SANDBOX:-0}"

mkdir -p "${HOME}" "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &

# --- Chrome args ---
CHROME_ARGS=(
  "--remote-debugging-address=127.0.0.1"
  "--remote-debugging-port=${CDP_PORT}"
  "--user-data-dir=${HOME}/.chrome"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-background-networking"
  "--disable-breakpad"
  "--disable-crash-reporter"
  "--no-zygote"
  "--metrics-recording-only"
  "--password-store=basic"
  "--use-mock-keychain"
)

if [[ "${HEADLESS}" == "1" ]]; then
  CHROME_ARGS+=("--headless=new")
fi

if [[ "${ALLOW_NO_SANDBOX}" == "1" ]]; then
  CHROME_ARGS+=("--no-sandbox" "--disable-setuid-sandbox")
fi

echo "[sandbox] Starting Chromium..."
chromium "${CHROME_ARGS[@]}" about:blank &
CHROME_PID=$!

MAX_RETRIES=30
RETRY_INTERVAL=1
CDP_READY=0

echo "[sandbox] Waiting for CDP on port ${CDP_PORT}..."

for ((i=1; i<=MAX_RETRIES; i++)); do
  if curl -s "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null; then
    CDP_READY=1
    break
  fi
  echo "[sandbox] Attempt $i/$MAX_RETRIES: CDP not ready..."
  sleep $RETRY_INTERVAL
done

if [[ "$CDP_READY" == "0" ]]; then
  echo "[sandbox] ERROR: CDP failed to start"
  kill -9 "$CHROME_PID" || true
  exit 1
fi

echo "[sandbox] CDP ready. Starting socat..."

SOCAT_LISTEN_ADDR="TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=0.0.0.0"
if [[ -n "${CDP_SOURCE_RANGE}" ]]; then
  SOCAT_LISTEN_ADDR="${SOCAT_LISTEN_ADDR},range=${CDP_SOURCE_RANGE}"
fi

socat "${SOCAT_LISTEN_ADDR}" "TCP:127.0.0.1:${CDP_PORT}" &

wait "$CHROME_PID"
