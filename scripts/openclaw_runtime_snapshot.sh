#!/usr/bin/env bash
set -euo pipefail
umask 077

STATE_DIR="/srv/openclaw/state"
JOBS_DIR="/srv/openclaw/jobs"
RUNTIME_JSON="${STATE_DIR}/runtime.json"
GATEWAY_HOST="127.0.0.1"
GATEWAY_PORT="18789"

mkdir -p "${STATE_DIR}"

if python3 - <<PY >/dev/null 2>&1
import socket
s = socket.create_connection(("${GATEWAY_HOST}", ${GATEWAY_PORT}), 2)
s.close()
PY
then
  gateway_health="up"
else
  gateway_health="down"
fi

opencode_container="$(docker ps --filter label=com.docker.compose.project=openclaw --filter label=com.docker.compose.service=opencode --format '{{.Names}}' | head -n1 || true)"
opencode_health="down"
if [ -n "${opencode_container}" ]; then
  opencode_health_raw="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${opencode_container}" 2>/dev/null || echo down)"
  case "${opencode_health_raw}" in
    healthy|running) opencode_health="up" ;;
    *) opencode_health="down" ;;
  esac
fi

active_jobs='[]'
if compgen -G "${JOBS_DIR}/*/status.json" > /dev/null; then
  active_jobs="$(jq -cs '
    [ .[]
      | select((.result // "") != "completed" and (.result // "") != "failed" and (.result // "") != "cancelled")
      | {jobId, repo, branch, phaseCurrent, phaseTotal, approvalNeeded, result, updatedAt}
    ]
  ' ${JOBS_DIR}/*/status.json 2>/dev/null || echo '[]')"
fi

pending_approvals=0
updated_at="$(date -Is)"
last_report_at="$(jq -r '.lastReportAt // empty' "${RUNTIME_JSON}" 2>/dev/null || true)"

jq -n \
  --arg gatewayHealth "${gateway_health}" \
  --arg opencodeHealth "${opencode_health}" \
  --arg updatedAt "${updated_at}" \
  --arg lastReportAt "${last_report_at}" \
  --argjson activeJobs "${active_jobs}" \
  --argjson pendingApprovals "${pending_approvals}" \
  '{
    gatewayHealth: $gatewayHealth,
    opencodeHealth: $opencodeHealth,
    activeJobs: $activeJobs,
    pendingApprovals: $pendingApprovals,
    lastReportAt: (if $lastReportAt == "" then null else $lastReportAt end),
    updatedAt: $updatedAt
  }' > "${RUNTIME_JSON}.tmp"

mv "${RUNTIME_JSON}.tmp" "${RUNTIME_JSON}"
chmod 600 "${RUNTIME_JSON}"

printf 'runtime snapshot updated: %s\n' "${RUNTIME_JSON}"
