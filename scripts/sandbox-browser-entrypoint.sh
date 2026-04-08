#!/usr/bin/env bash
set -euo pipefail

export DBUS_SESSION_BUS_ADDRESS=/dev/null

export DISPLAY=:1
export HOME=/tmp/openclaw-home
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${OPENCLAW_BROWSER_CDP_PORT:-9222}"
CDP_SOURCE_RANGE="${OPENCLAW_BROWSER_CDP_SOURCE_RANGE:-}"
VNC_PORT="${OPENCLAW_BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${OPENCLAW_BROWSER_NOVNC_PORT:-6080}"
ENABLE_NOVNC="${OPENCLAW_BROWSER_ENABLE_NOVNC:-1}"
HEADLESS="${OPENCLAW_BROWSER_HEADLESS:-0}"
ALLOW_NO_SANDBOX="${OPENCLAW_BROWSER_NO_SANDBOX:-0}"
NOVNC_PASSWORD="${OPENCLAW_BROWSER_NOVNC_PASSWORD:-}"

DISABLE_GRAPHICS_FLAGS="${OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS:-1}"
DISABLE_EXTENSIONS="${OPENCLAW_BROWSER_DISABLE_EXTENSIONS:-1}"
RENDERER_PROCESS_LIMIT="${OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT:-2}"
AUTO_START_TIMEOUT_MS="${OPENCLAW_BROWSER_AUTO_START_TIMEOUT_MS:-12000}"

mkdir -p "${HOME}" "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &

if [[ "${CDP_PORT}" -ge 65535 ]]; then
  CHROME_CDP_PORT="$((CDP_PORT - 1))"
else
  CHROME_CDP_PORT="$((CDP_PORT + 1))"
fi

CHROME_ARGS=(
  "--remote-debugging-address=127.0.0.1"
  "--remote-debugging-port=${CHROME_CDP_PORT}"
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

DISABLE_GRAPHICS_FLAGS_LOWER="${DISABLE_GRAPHICS_FLAGS,,}"
if [[ "${DISABLE_GRAPHICS_FLAGS_LOWER}" =~ ^(1|true|yes|on)$ ]]; then
  CHROME_ARGS+=(
    "--disable-3d-apis"
    "--disable-gpu"
    "--disable-software-rasterizer"
  )
fi

DISABLE_EXTENSIONS_LOWER="${DISABLE_EXTENSIONS,,}"
if [[ "${DISABLE_EXTENSIONS_LOWER}" =~ ^(1|true|yes|on)$ ]]; then
  CHROME_ARGS+=("--disable-extensions")
fi

if [[ "${RENDERER_PROCESS_LIMIT}" =~ ^[0-9]+$ && "${RENDERER_PROCESS_LIMIT}" -gt 0 ]]; then
  CHROME_ARGS+=("--renderer-process-limit=${RENDERER_PROCESS_LIMIT}")
fi

echo "[sandbox] Starting Chromium..."
chromium "${CHROME_ARGS[@]}" about:blank &
CHROME_PID=$!

MAX_RETRIES=$(( AUTO_START_TIMEOUT_MS / 1000 ))
if [[ "$MAX_RETRIES" -le 0 ]]; then MAX_RETRIES=1; fi
RETRY_INTERVAL=1
CDP_READY=0

echo "[sandbox] Waiting up to ${MAX_RETRIES}s for CDP on port ${CHROME_CDP_PORT}..."

for ((i=1; i<=MAX_RETRIES; i++)); do
  if curl -s --max-time 1 "http://127.0.0.1:${CHROME_CDP_PORT}/json/version" > /dev/null; then
    CDP_READY=1
    break
  fi
  echo "[sandbox] Attempt $i/$MAX_RETRIES: CDP not ready..."
  sleep $RETRY_INTERVAL
done

if [[ "$CDP_READY" == "0" ]]; then
  echo "[sandbox] ERROR: CDP failed to start within ${MAX_RETRIES}s."
  kill -9 "$CHROME_PID" || true
  exit 1
fi

echo "[sandbox] CDP ready. Starting socat..."

SOCAT_LISTEN_ADDR="TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=0.0.0.0"
if [[ -n "${CDP_SOURCE_RANGE}" ]]; then
  SOCAT_LISTEN_ADDR="${SOCAT_LISTEN_ADDR},range=${CDP_SOURCE_RANGE}"
fi

socat "${SOCAT_LISTEN_ADDR}" "TCP:127.0.0.1:${CHROME_CDP_PORT}" &

if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
  if [[ -z "${NOVNC_PASSWORD}" ]]; then
    NOVNC_PASSWORD="$(< /proc/sys/kernel/random/uuid)"
    NOVNC_PASSWORD="${NOVNC_PASSWORD//-/}"
    NOVNC_PASSWORD="${NOVNC_PASSWORD:0:8}"
  fi

  mkdir -p "${HOME}/.vnc"
  x11vnc -storepasswd "${NOVNC_PASSWORD}" "${HOME}/.vnc/passwd" >/dev/null
  chmod 600 "${HOME}/.vnc/passwd"

  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -rfbauth "${HOME}/.vnc/passwd" -localhost &
  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
fi

wait "$CHROME_PID"
