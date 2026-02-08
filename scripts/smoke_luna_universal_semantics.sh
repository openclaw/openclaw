#!/usr/bin/env bash
set -euo pipefail

PROOF_DIR=${PROOF_DIR:-/home/dado/PROOF/luna_universal_semantics_20260207T110435Z}
OPENCLAW_TOOL_MAX_TIME=${OPENCLAW_TOOL_MAX_TIME:-120}
OPENCLAW_TOOL_CONNECT_TIMEOUT=${OPENCLAW_TOOL_CONNECT_TIMEOUT:-12}
OPENCLAW_TOOL_RETRIES=${OPENCLAW_TOOL_RETRIES:-3}
mkdir -p "${PROOF_DIR}"
mkdir -p "${PROOF_DIR}/gateway"
SMOKE_SEARCH_LOG="${PROOF_DIR}/smoke_search.log"

log_search() {
  local pattern="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    echo "[MISSING_FILE] PATTERN=${pattern} FILE=${file}" | tee -a "${SMOKE_SEARCH_LOG}"
    return 1
  fi
  if ! grep -nE "${pattern}" "${file}" | tee -a "${SMOKE_SEARCH_LOG}"; then
    echo "[NO_MATCH] PATTERN=${pattern} FILE=${file}" | tee -a "${SMOKE_SEARCH_LOG}"
    return 0
  fi
  return 0
}

echo "${PROOF_DIR}" > "${PROOF_DIR}/PROOF_DIR.txt"

echo "== gateway build ==" > "${PROOF_DIR}/gateway_build.log"
if ! docker compose build openclaw-gateway >> "${PROOF_DIR}/gateway_build.log" 2>&1; then
  echo "Gateway build failed. See ${PROOF_DIR}/gateway_build.log" >&2
  exit 1
fi

docker compose restart openclaw-gateway > "${PROOF_DIR}/restart.txt" 2>&1

echo "== health wait ==" > "${PROOF_DIR}/health_wait.log"
for i in $(seq 1 30); do
  status=$(curl -s --retry 3 --retry-delay 1 --retry-connrefused --retry-max-time 12 --connect-timeout 5 --max-time 8 -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health || true)
  echo "attempt ${i}: ${status}" >> "${PROOF_DIR}/health_wait.log"
  if [[ "${status}" == "200" ]]; then
    break
  fi
  sleep 1
done

docker logs --tail 250 openclaw-openclaw-gateway-1 > "${PROOF_DIR}/gateway_logs_after_restart.txt" 2>&1 || true

echo "== gateway readiness ==" > "${PROOF_DIR}/gateway/gateway_wait_smoke.log"
for i in $(seq 1 90); do
  code=$(curl -sS --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/__openclaw__/canvas/ || echo "000")
  echo "attempt ${i}: ${code}" >> "${PROOF_DIR}/gateway/gateway_wait_smoke.log"
  if [[ "${code}" == "200" || "${code}" == "204" || "${code}" == "302" || "${code}" == "401" || "${code}" == "403" || "${code}" == "404" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" && -f "/home/dado/openclaw/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "/home/dado/openclaw/.env"
  set +a
fi

export PROOF_DIR
export OPENCLAW_TOOL_MAX_TIME
export OPENCLAW_TOOL_CONNECT_TIMEOUT
  export OPENCLAW_TOOL_RETRIES

if [[ -n "${LATEST_PROOF:-}" ]]; then
  export LATEST_PROOF
fi
if [[ -x "/home/dado/openclaw/scripts/luna_quicktests_debug.sh" ]]; then
  bash /home/dado/openclaw/scripts/luna_quicktests_debug.sh || {
    echo "Luna quicktests failed. See ${PROOF_DIR}/luna_tests/ for logs." >&2
    exit 1
  }
fi

node /home/dado/openclaw/scripts/universal_semantics_proof.mjs | tee "${PROOF_DIR}/smoke.log"

if ! log_search "OVERALL (PASS|FAIL)" "${PROOF_DIR}/smoke.log"; then
  echo "Missing smoke.log after proof run." >&2
  exit 1
fi
