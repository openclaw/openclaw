#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3102}"
HOST="${HOST:-127.0.0.1}"
BASE_URL="${MC_TEST_BASE_URL:-http://${HOST}:${PORT}}"
TEST_API_KEY="${MC_TEST_API_KEY:-ci-smoke-key}"
LOG_DIR="${LOG_DIR:-output/playwright}"
mkdir -p "${LOG_DIR}"

server_pid=""
cleanup() {
  if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" >/dev/null 2>&1; then
    kill "${server_pid}" >/dev/null 2>&1 || true
    wait "${server_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ ! -f ".next/BUILD_ID" ]]; then
  echo "No production build detected. Running build..."
  npm run build
fi

echo "Starting Mission Control for API contract smoke on ${BASE_URL}..."
MISSION_CONTROL_API_KEY="${TEST_API_KEY}" \
MISSION_CONTROL_CSRF_PROTECTION="false" \
RISK_LEVEL="medium" \
PORT="${PORT}" npm run start >"${LOG_DIR}/next-start-api.log" 2>&1 &
server_pid="$!"

echo "Waiting for server readiness..."
ready="false"
for _ in $(seq 1 90); do
  if curl -fsS "${BASE_URL}" >/dev/null 2>&1; then
    ready="true"
    break
  fi
  sleep 1
done

if [[ "${ready}" != "true" ]]; then
  echo "Server did not become ready at ${BASE_URL}"
  tail -n 80 "${LOG_DIR}/next-start-api.log" || true
  exit 1
fi

MC_TEST_BASE_URL="${BASE_URL}" MC_TEST_API_KEY="${TEST_API_KEY}" npm run test:api-contract
