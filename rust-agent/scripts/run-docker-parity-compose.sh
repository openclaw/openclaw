#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/docker-compose.parity.yml"
PROJECT="openclaw-rs-parity"

set +e
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" up \
  --build \
  --abort-on-container-exit \
  --exit-code-from assertor
status=$?
set -e

docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" down -v --remove-orphans
exit ${status}
