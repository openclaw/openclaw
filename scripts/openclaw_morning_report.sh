#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="/home/tjrgus/openclaw"
STATE_FILE="/srv/openclaw/state/runtime.json"
REPORT_DIR="/home/tjrgus/shared/openclaw_ops/reports"
TS="$(date +%Y-%m-%d_%H-%M-%S)"
OUT_FILE="${REPORT_DIR}/morning_report_${TS}.txt"

mkdir -p "${REPORT_DIR}"
"${ROOT_DIR}/scripts/openclaw_runtime_snapshot.sh" >/dev/null

{
  echo "OpenClaw Morning Report"
  echo "Generated: $(date -Is)"
  echo "Host: $(hostname)"
  echo
  echo "== Runtime State =="
  jq . "${STATE_FILE}"
  echo
  echo "== Compose Services =="
  (cd "${ROOT_DIR}" && docker compose ps)
  echo
  echo "== OpenCode Reachability (Gateway -> Sidecar) =="
  if "${ROOT_DIR}/scripts/openclaw_opencode_reachability.sh"; then
    echo "opencode_link: PASS"
  else
    echo "opencode_link: FAIL"
  fi
  echo
  echo "== Host Gateway Port Probe =="
  if python3 - <<'PY'
import socket
s = socket.create_connection(("127.0.0.1", 18789), 2)
s.close()
print("gateway_port: OPEN (127.0.0.1:18789)")
PY
  then
    :
  else
    echo "gateway_port: CLOSED (127.0.0.1:18789)"
  fi
} | tee "${OUT_FILE}"

report_ts="$(date -Is)"
jq --arg ts "${report_ts}" '.lastReportAt = $ts | .updatedAt = $ts' "${STATE_FILE}" > "${STATE_FILE}.tmp"
mv "${STATE_FILE}.tmp" "${STATE_FILE}"
chmod 600 "${STATE_FILE}"

echo
echo "Saved report: ${OUT_FILE}"
