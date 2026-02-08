#!/usr/bin/env bash
set -euo pipefail

timestamp=$(date -u +"%Y%m%dT%H%M%SZ")
PROOF_DIR=${PROOF_DIR:-/home/dado/PROOF/luna_universal_understanding_${timestamp}}

mkdir -p "${PROOF_DIR}"

echo "${PROOF_DIR}" > "${PROOF_DIR}/PROOF_PATH.txt"
echo "${timestamp}" > "${PROOF_DIR}/TS_UTC.txt"

{
  echo "== sudo restart =="
  sudo docker compose restart openclaw-gateway
} > "${PROOF_DIR}/restart.log" 2>&1 || {
  echo "sudo restart failed, falling back to non-sudo" >> "${PROOF_DIR}/restart.log"
  docker compose restart openclaw-gateway >> "${PROOF_DIR}/restart.log" 2>&1 || true
}

docker compose logs --tail 200 openclaw-gateway > "${PROOF_DIR}/gateway_logs_tail.txt" 2>&1 || true

export PROOF_DIR

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" && -f "/home/dado/openclaw/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "/home/dado/openclaw/.env"
  set +a
fi

{
  echo "== gateway health wait =="
  for i in $(seq 1 30); do
    status=$(curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health || true)
    echo "attempt ${i}: ${status}"
    if [[ "${status}" == "200" ]]; then
      break
    fi
    sleep 1
  done
} > "${PROOF_DIR}/health_wait.log" 2>&1 || true

node /home/dado/openclaw/scripts/universal_control_proof.mjs | tee "${PROOF_DIR}/smoke.log"
