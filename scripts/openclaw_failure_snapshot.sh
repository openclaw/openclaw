#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <job-id> <reason>" >&2
  exit 2
fi

JOB_ID="$1"
REASON="$2"
JOB_DIR="/srv/openclaw/jobs/${JOB_ID}"
STATUS_FILE="${JOB_DIR}/status.json"

mkdir -p "${JOB_DIR}"

if [ -f "${STATUS_FILE}" ]; then
  jq --arg reason "${REASON}" --arg updatedAt "$(date -Is)" '
    .result = "failed"
    | .approvalNeeded = false
    | .lastCheck = "failure-snapshot"
    | .nextAction = $reason
    | .updatedAt = $updatedAt
  ' "${STATUS_FILE}" > "${STATUS_FILE}.tmp"
  mv "${STATUS_FILE}.tmp" "${STATUS_FILE}"
else
  jq -n --arg jobId "${JOB_ID}" --arg reason "${REASON}" --arg updatedAt "$(date -Is)" '{
    jobId: $jobId,
    result: "failed",
    nextAction: $reason,
    lastCheck: "failure-snapshot",
    approvalNeeded: false,
    updatedAt: $updatedAt
  }' > "${STATUS_FILE}"
fi
chmod 600 "${STATUS_FILE}"

docker logs openclaw-openclaw-gateway-1 --tail 200 > "${JOB_DIR}/gateway.tail.log" 2>&1 || true
docker logs openclaw-opencode-1 --tail 200 > "${JOB_DIR}/opencode.tail.log" 2>&1 || true
chmod 600 "${JOB_DIR}"/*.log 2>/dev/null || true

echo "failure snapshot saved: ${JOB_DIR}"
