#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3101}"
HOST="${HOST:-127.0.0.1}"
BASE_URL="${MC_AUDIT_BASE_URL:-http://${HOST}:${PORT}}"
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

echo "Starting Mission Control on ${BASE_URL}..."
if [[ ! -f ".next/BUILD_ID" ]]; then
  echo "No production build detected. Running build..."
  npm run build
fi

PORT="${PORT}" npm run start >"${LOG_DIR}/next-start.log" 2>&1 &
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
  echo "Last server log lines:"
  tail -n 80 "${LOG_DIR}/next-start.log" || true
  exit 1
fi

echo "Running scroll/chat audit..."
MC_AUDIT_BASE_URL="${BASE_URL}" npm run audit:scroll-chat
