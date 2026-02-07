#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"

service="${1:-}"
if [[ -n "${service}" ]]; then
  docker compose -f "${COMPOSE_FILE}" logs -f --tail=200 "${service}"
  exit 0
fi

docker compose -f "${COMPOSE_FILE}" logs -f --tail=200 openclaw mux-server
