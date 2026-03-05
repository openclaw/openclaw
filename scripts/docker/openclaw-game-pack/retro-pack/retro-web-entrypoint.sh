#!/usr/bin/env bash
set -euo pipefail

: "${DISPLAY:=:1}"
: "${XVFB_WHD:=1280x720x24}"
: "${NOVNC_PORT:=6080}"
: "${VNC_PORT:=5900}"

if [[ -z "${GAME_CMD:-}" ]]; then
  echo "GAME_CMD is required (for example: GAME_CMD=opentyrian)" >&2
  exit 2
fi

pids=()

cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "$XVFB_WHD" -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
pids+=("$!")

for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "Xvfb did not start on $DISPLAY" >&2
  exit 1
fi

fluxbox >/tmp/fluxbox.log 2>&1 &
pids+=("$!")

x11vnc -display "$DISPLAY" -rfbport "$VNC_PORT" -shared -forever -nopw -xkb >/tmp/x11vnc.log 2>&1 &
pids+=("$!")

websockify --web=/usr/share/novnc/ "$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/tmp/websockify.log 2>&1 &
pids+=("$!")

echo "noVNC ready: http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote"

bash -lc "$GAME_CMD" &
game_pid="$!"
wait "$game_pid"
