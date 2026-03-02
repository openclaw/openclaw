#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <job-id> [result] [next-action]" >&2
  exit 2
fi

JOB_ID="$1"
RESULT="${2:-completed}"
NEXT_ACTION="${3:-idle}"
STATUS_FILE="/srv/openclaw/jobs/${JOB_ID}/status.json"

if [ ! -f "${STATUS_FILE}" ]; then
  echo "status file not found: ${STATUS_FILE}" >&2
  exit 1
fi

updated_at="$(date -Is)"

jq --arg result "${RESULT}" --arg nextAction "${NEXT_ACTION}" --arg updatedAt "${updated_at}" '
  .result = $result
  | .nextAction = $nextAction
  | .lastCheck = "postrun-summary"
  | .updatedAt = $updatedAt
' "${STATUS_FILE}" > "${STATUS_FILE}.tmp"

mv "${STATUS_FILE}.tmp" "${STATUS_FILE}"
chmod 600 "${STATUS_FILE}"

jq '{jobId,repo,branch,phaseCurrent,phaseTotal,result,nextAction,updatedAt}' "${STATUS_FILE}"
