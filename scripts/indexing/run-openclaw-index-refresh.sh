#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOCK_DIR="${HOME}/.openclaw-index-refresh.lock"
LOG_DIR="${REPO_ROOT}/.openclaw-index/logs"
mkdir -p "${LOG_DIR}"

TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_DIR}/refresh-${TS}.log"
LATEST_LOG="${LOG_DIR}/latest.log"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "[$(date -u +%FT%TZ)] refresh skipped: lock is active" >> "${LATEST_LOG}"
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" >/dev/null 2>&1 || true' EXIT

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.nvm/versions/node/v22.22.0/bin:${PATH:-}"

NODE_BIN="${OPENCLAW_INDEX_NODE_BIN:-}"
if [[ -z "${NODE_BIN}" ]]; then
  shopt -s nullglob
  NVM_NODE_BINS=( "${HOME}"/.nvm/versions/node/*/bin/node )
  shopt -u nullglob

  if [[ "${#NVM_NODE_BINS[@]}" -gt 0 ]]; then
    IFS=$'\n' NVM_NODE_BINS_SORTED=( $(printf '%s\n' "${NVM_NODE_BINS[@]}" | sort -V) )
    unset IFS
  else
    NVM_NODE_BINS_SORTED=()
  fi

  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "${NVM_NODE_BINS_SORTED[@]}" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi

STATUS=0
{
  echo "[$(date -u +%FT%TZ)] starting refresh"
  cd "${REPO_ROOT}"
  if [[ -z "${NODE_BIN}" ]]; then
    echo "[$(date -u +%FT%TZ)] ERROR: node binary not found"
    STATUS=127
  else
    "${NODE_BIN}" scripts/indexing/refresh-openclaw-index.mjs || STATUS=$?
  fi
  if [[ "${STATUS}" -eq 0 ]]; then
    echo "[$(date -u +%FT%TZ)] refresh completed"
  else
    echo "[$(date -u +%FT%TZ)] refresh failed with status ${STATUS}"
  fi
} >> "${LOG_FILE}" 2>&1

cp "${LOG_FILE}" "${LATEST_LOG}"
exit "${STATUS}"
