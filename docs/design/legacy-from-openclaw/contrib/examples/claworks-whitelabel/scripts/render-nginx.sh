#!/usr/bin/env bash
# Render nginx.conf from nginx.conf.template + .env
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${ROOT}/nginx/nginx.conf.template"
OUT="${ROOT}/nginx/nginx.conf"
ENV_FILE="${1:-${ROOT}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.example to .env and edit." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

required=(PUBLIC_HOST OPENCLAW_UPSTREAM CLAWORKS_UPSTREAM TLS_CERT_PATH TLS_KEY_PATH STUDIO_STATIC_ROOT)
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "Set ${key} in ${ENV_FILE}" >&2
    exit 1
  fi
done

export PUBLIC_HOST OPENCLAW_UPSTREAM CLAWORKS_UPSTREAM TLS_CERT_PATH TLS_KEY_PATH STUDIO_STATIC_ROOT

envsubst '${PUBLIC_HOST} ${OPENCLAW_UPSTREAM} ${CLAWORKS_UPSTREAM} ${TLS_CERT_PATH} ${TLS_KEY_PATH} ${STUDIO_STATIC_ROOT}' \
  < "${TEMPLATE}" > "${OUT}"

echo "Wrote ${OUT}"
