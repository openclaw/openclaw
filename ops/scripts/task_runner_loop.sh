#!/usr/bin/env bash
set -euo pipefail

echo "[voltaris] autonomous task engine started"

while true; do
  /home/spryguy/openclaw-workspace/repos/openclaw/ops/scripts/task_runner.sh
  sleep 10
done
