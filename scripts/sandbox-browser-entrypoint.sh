#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:1

CDP_PORT="${CLAWDIS_BROWSER_CDP_PORT:-9222}"
VNC_PORT="${CLAWDIS_BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${CLAWDIS_BROWSER_NOVNC_PORT:-6080}"
ENABLE_NOVNC="${CLAWDIS_BROWSER_ENABLE_NOVNC:-1}"
HEADLESS="${CLAWDIS_BROWSER_HEADLESS:-0}"

mkdir -p /workspace/.chrome
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &

if [[ "${HEADLESS}" == "1" ]]; then
  CHROME_ARGS=(
    "--headless=new"
    "--disable-gpu"
  )
else
  CHROME_ARGS=()
fi

CHROME_ARGS+=(
  "--remote-debugging-address=0.0.0.0"
  "--remote-debugging-port=${CDP_PORT}"
  "--user-data-dir=/workspace/.chrome"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-background-networking"
  "--disable-features=TranslateUI"
  "--disable-breakpad"
  "--disable-crash-reporter"
  "--metrics-recording-only"
  "--no-sandbox"
)

chromium "${CHROME_ARGS[@]}" about:blank &

if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -nopw -localhost &
  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
fi

wait -n
