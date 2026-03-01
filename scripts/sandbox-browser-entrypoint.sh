#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:1
export HOME=/tmp/openclaw-home
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${OPENCLAW_BROWSER_CDP_PORT:-${CLAWDBOT_BROWSER_CDP_PORT:-9222}}"
CDP_SOURCE_RANGE="${OPENCLAW_BROWSER_CDP_SOURCE_RANGE:-${CLAWDBOT_BROWSER_CDP_SOURCE_RANGE:-}}"
VNC_PORT="${OPENCLAW_BROWSER_VNC_PORT:-${CLAWDBOT_BROWSER_VNC_PORT:-5900}}"
NOVNC_PORT="${OPENCLAW_BROWSER_NOVNC_PORT:-${CLAWDBOT_BROWSER_NOVNC_PORT:-6080}}"
ENABLE_NOVNC="${OPENCLAW_BROWSER_ENABLE_NOVNC:-${CLAWDBOT_BROWSER_ENABLE_NOVNC:-1}}"
HEADLESS="${OPENCLAW_BROWSER_HEADLESS:-${CLAWDBOT_BROWSER_HEADLESS:-0}}"
ALLOW_NO_SANDBOX="${OPENCLAW_BROWSER_NO_SANDBOX:-${CLAWDBOT_BROWSER_NO_SANDBOX:-0}}"
NOVNC_PASSWORD="${OPENCLAW_BROWSER_NOVNC_PASSWORD:-${CLAWDBOT_BROWSER_NOVNC_PASSWORD:-}}"

mkdir -p "${HOME}" "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &

if [[ "${HEADLESS}" == "1" ]]; then
  CHROME_ARGS=(
    "--headless=new"
    "--disable-gpu"
  )
else
  CHROME_ARGS=()
fi

if [[ "${CDP_PORT}" -ge 65535 ]]; then
  CHROME_CDP_PORT="$((CDP_PORT - 1))"
else
  CHROME_CDP_PORT="$((CDP_PORT + 1))"
fi

CHROME_ARGS+=(
  "--remote-debugging-address=127.0.0.1"
  "--remote-debugging-port=${CHROME_CDP_PORT}"
  "--user-data-dir=${HOME}/.chrome"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-background-networking"
  "--disable-features=TranslateUI"
  "--disable-breakpad"
  "--disable-crash-reporter"
  "--metrics-recording-only"
)

if [[ "${ALLOW_NO_SANDBOX}" == "1" ]]; then
  CHROME_ARGS+=(
    "--no-sandbox"
    "--disable-setuid-sandbox"
  )
fi

chromium "${CHROME_ARGS[@]}" about:blank &

for _ in $(seq 1 50); do
  if curl -sS --max-time 1 "http://127.0.0.1:${CHROME_CDP_PORT}/json/version" >/dev/null; then
    break
  fi
  sleep 0.1
done

SOCAT_LISTEN_ADDR="TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=0.0.0.0"
if [[ -n "${CDP_SOURCE_RANGE}" ]]; then
  SOCAT_LISTEN_ADDR="${SOCAT_LISTEN_ADDR},range=${CDP_SOURCE_RANGE}"
fi
socat "${SOCAT_LISTEN_ADDR}" "TCP:127.0.0.1:${CHROME_CDP_PORT}" &

if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
  # VNC auth passwords are max 8 chars; use a random default when not provided.
  if [[ -z "${NOVNC_PASSWORD}" ]]; then
    NOVNC_PASSWORD="$(< /proc/sys/kernel/random/uuid)"
    NOVNC_PASSWORD="${NOVNC_PASSWORD//-/}"
    NOVNC_PASSWORD="${NOVNC_PASSWORD:0:8}"
  fi
  NOVNC_PASSWD_FILE="${HOME}/.vnc/passwd"
  mkdir -p "${HOME}/.vnc"
  x11vnc -storepasswd "${NOVNC_PASSWORD}" "${NOVNC_PASSWD_FILE}" >/dev/null
  chmod 600 "${NOVNC_PASSWD_FILE}"
  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -rfbauth "${NOVNC_PASSWD_FILE}" -localhost &
  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
fi

wait -n
