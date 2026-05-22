#!/usr/bin/env bash
# Optional: start OrioSearch (Docker Compose) so OpenClaw can point tavily webSearch.baseUrl at it.
# OpenClaw does not embed or auto-start Orio; run this (or your own compose/systemd) before the gateway.
set -euo pipefail

ROOT="${ORIOSEARCH_ROOT:-}"
if [[ -z "${ROOT}" ]]; then
  echo "Set ORIOSEARCH_ROOT to your OrioSearch clone (directory containing docker-compose.yml)." >&2
  exit 1
fi

cd "${ROOT}"
docker compose up -d
echo "OrioSearch stack started. API is typically at http://127.0.0.1:8000 (see upstream README / compose)."
