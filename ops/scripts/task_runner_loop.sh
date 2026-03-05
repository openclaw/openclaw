#!/usr/bin/env bash
set -euo pipefail

echo "[voltaris] autonomous task engine started"

LAST_INSPECT=0

while true; do
  /home/spryguy/openclaw-workspace/repos/openclaw/ops/scripts/task_runner.sh

  NOW=$(date +%s)

  # Run repo inspection once per hour
  if (( NOW - LAST_INSPECT > 3600 )); then
    echo "[voltaris] running scheduled repo inspection"
    /home/spryguy/openclaw-workspace/repos/openclaw/ops/scripts/inspect_repo.sh || true
    LAST_INSPECT=$NOW
  fi

  sleep 10
done
