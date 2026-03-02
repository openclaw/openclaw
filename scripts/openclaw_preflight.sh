#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="/home/tjrgus/openclaw"
REPORT_DIR="/home/tjrgus/shared/openclaw_ops/reports"
RUNTIME_SNAPSHOT_SCRIPT="${ROOT_DIR}/scripts/openclaw_runtime_snapshot.sh"
OPENCODE_REACHABILITY_SCRIPT="${ROOT_DIR}/scripts/openclaw_opencode_reachability.sh"
MOUNT_CHECK_SCRIPT="${ROOT_DIR}/scripts/check_sensitive_mounts.sh"
TS="$(date +%Y-%m-%d_%H-%M-%S)"
REPORT_FILE="${REPORT_DIR}/openclaw_preflight_${TS}.txt"

mkdir -p "${REPORT_DIR}"

{
  echo "OpenClaw Preflight Report"
  echo "Generated: $(date -Is)"
  echo "Host: $(hostname)"
  echo

  echo "== Docker Compose Status =="
  (cd "${ROOT_DIR}" && docker compose ps)
  echo

  echo "== Gateway Container Commands =="
  if docker ps --format '{{.Names}}' | grep -q '^openclaw-openclaw-gateway-1$'; then
    docker exec openclaw-openclaw-gateway-1 sh -lc 'for c in lobster node npm pnpm git curl; do command -v "$c" || true; done'
  else
    echo "Gateway container not running."
  fi
  echo

  echo "== Lobster CLI Smoke Test =="
  LOBSTER_OUT="$(docker exec openclaw-openclaw-gateway-1 sh -lc \
    "lobster run --mode tool \"exec --shell \\\"echo '[1,2,3]'\\\" | json\"" 2>/dev/null || true)"
  if rg -q '"ok"\s*:\s*true' <<<"${LOBSTER_OUT}"; then
    echo "lobster_smoke: PASS"
  else
    echo "lobster_smoke: FAIL"
    printf '%s\n' "${LOBSTER_OUT}" | tail -n 20
  fi
  echo

  echo "== Plugin State (telegram/memory-core/llm-task/lobster) =="
  docker exec openclaw-openclaw-gateway-1 node dist/index.js plugins list --json \
    | jq '.plugins[] | select(.id=="telegram" or .id=="memory-core" or .id=="llm-task" or .id=="lobster") | {id,enabled}'
  echo

  echo "== Effective Tools Config =="
  docker exec openclaw-openclaw-gateway-1 node dist/index.js config get tools --json
  echo

  echo "== Effective Approvals Config =="
  docker exec openclaw-openclaw-gateway-1 node dist/index.js config get approvals --json
  echo

  echo "== Exec Approvals File (policy source of truth) =="
  jq '{defaults,agents}' /home/tjrgus/.openclaw/exec-approvals.json
  echo

  echo "== BRAVE_API_KEY Presence in Gateway =="
  docker exec openclaw-openclaw-gateway-1 sh -lc 'if [ -n "${BRAVE_API_KEY:-}" ]; then echo "BRAVE_API_KEY: SET"; else echo "BRAVE_API_KEY: MISSING"; fi'
  echo

  echo "== OpenCode Sidecar Health =="
  OPENCODE_CID="$(docker ps --filter label=com.docker.compose.project=openclaw --filter label=com.docker.compose.service=opencode --format '{{.ID}}' | head -n1 || true)"
  if [ -n "${OPENCODE_CID}" ]; then
    docker inspect -f 'container={{.Name}} state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${OPENCODE_CID}"
  else
    echo "opencode sidecar not running"
  fi
  if "${OPENCODE_REACHABILITY_SCRIPT}"; then
    echo "gateway_to_opencode: PASS"
  else
    echo "gateway_to_opencode: FAIL"
  fi
  echo

  echo "== Runtime Snapshot =="
  "${RUNTIME_SNAPSHOT_SCRIPT}" >/dev/null
  jq . /srv/openclaw/state/runtime.json
  echo

  echo "== Sensitive Mount Guard =="
  "${MOUNT_CHECK_SCRIPT}" openclaw-openclaw-gateway-1
  echo

  echo "== Gateway Health =="
  docker exec openclaw-openclaw-gateway-1 node dist/index.js status --all
  echo

  echo "== Security Audit (deep) =="
  docker exec openclaw-openclaw-gateway-1 node dist/index.js security audit --deep
} | tee "${REPORT_FILE}"

echo
echo "Saved report: ${REPORT_FILE}"
