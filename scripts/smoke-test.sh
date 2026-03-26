#!/bin/bash
set -e

echo "Running smoke tests..."
echo "1. Checking if OpenClaw Gateway is up..."
curl -s http://127.0.0.1:18789/healthz > /dev/null || echo "Gateway might be down or not responding."

echo "2. Checking artifact directories..."
if [ -d "${OPENCLAW_ARTIFACTS_DIR:-./artifacts}" ]; then
    echo " Artifacts dir exists."
else
    echo " Artifacts dir missing!"
fi

echo "Smoke tests complete."
