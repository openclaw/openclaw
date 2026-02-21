#!/usr/bin/env bash
set -euo pipefail

PROFILE="${OPENCLAW_PROFILE:-clawos}"
REPO="${HOME}/ClawOS1"
CLAW="${REPO}/clawos/scripts/clawos"
LOG="$(ls -1t /tmp/openclaw/openclaw-*.log 2>/dev/null | head -n 1 || true)"

cmd="${1:-help}"
shift || true

case "${cmd}" in
  help)
    cat <<'TXT'
[openclaw] Ops commands:
- health
- status
- logs
- uptime
- restart gateway <PIN>
TXT
    ;;

  health)
    echo "[openclaw] ✅ Health"
    "${CLAW}" --profile "${PROFILE}" gateway status | sed -n '1,80p'
    echo
    "${CLAW}" --profile "${PROFILE}" status --deep | grep -E "WhatsApp|Gateway:|Listening:|Agents|Sessions|Last heartbeat" || true
    ;;

  status)
    echo "[openclaw] 🧠 Status"
    "${CLAW}" --profile "${PROFILE}" status --deep | sed -n '1,120p'
    ;;

  logs)
    echo "[openclaw] 🧾 Logs (last 120)"
    if [[ -z "${LOG}" ]]; then
      echo "No log file found in /tmp/openclaw/"
      exit 0
    fi
    tail -n 120 "${LOG}"
    ;;

  uptime)
    echo "[openclaw] ⏱ Uptime"
    "${CLAW}" --profile "${PROFILE}" gateway status | grep -E "Runtime:|Command:|Service:" || true
    ;;

  restart)
    sub="${1:-}"
    if [[ "${sub}" != "gateway" ]]; then
      echo "[openclaw] Usage: restart gateway <PIN>"
      exit 0
    fi
    pin="${2:-}"
    required="${OPENCLAW_OPS_PIN:-1234}"
    if [[ "${pin}" != "${required}" ]]; then
      echo "[openclaw] ❌ Wrong PIN. Usage: restart gateway <PIN>"
      exit 0
    fi

    echo "[openclaw] 🔁 Restarting gateway…"
    "${CLAW}" --profile "${PROFILE}" gateway restart >/dev/null
    sleep 1
    "${0}" health
    ;;

  *)
    echo "[openclaw] Unknown ops command: ${cmd}"
    "${0}" help
    ;;
esac
