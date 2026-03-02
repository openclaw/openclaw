#!/usr/bin/env bash
set -euo pipefail

GATEWAY_CONTAINER="openclaw-openclaw-gateway-1"
TARGET_URL="http://opencode:39200"

if ! docker ps --format '{{.Names}}' | grep -q "^${GATEWAY_CONTAINER}$"; then
  echo "gateway container not running: ${GATEWAY_CONTAINER}" >&2
  exit 1
fi

code="$(docker exec "${GATEWAY_CONTAINER}" sh -lc "curl -sS -o /dev/null -w '%{http_code}' ${TARGET_URL} || true")"
if [ -n "${code}" ] && [ "${code}" != "000" ]; then
  echo "reachable code=${code}"
  exit 0
fi

echo "unreachable"
exit 1
