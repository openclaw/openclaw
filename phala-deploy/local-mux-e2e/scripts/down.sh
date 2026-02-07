#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"

if [[ "${1:-}" == "--wipe" ]]; then
  docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans
  rm -rf "${STACK_DIR}/state/wa-auth/default"
  echo "[local-mux-e2e] stack stopped and local test state wiped"
  exit 0
fi

docker compose -f "${COMPOSE_FILE}" down --remove-orphans
echo "[local-mux-e2e] stack stopped"
