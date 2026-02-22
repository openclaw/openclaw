#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check-signal-runtime.sh [options]

Options:
  --samples <n>      Number of docker stats samples (default: 20)
  --interval <sec>   Seconds between samples (default: 2)
  --since <window>   Log window for docker compose logs (default: 5m)
  --signal <name>    Signal docker compose service name (default: signal)
  --gateway <name>   Gateway docker compose service name (default: openclaw-gateway)
  -h, --help         Show this help
EOF
}

SAMPLES=20
INTERVAL=2
SINCE="5m"
SIGNAL_SERVICE="signal"
GATEWAY_SERVICE="openclaw-gateway"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --samples)
      SAMPLES="${2:-}"
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-}"
      shift 2
      ;;
    --since)
      SINCE="${2:-}"
      shift 2
      ;;
    --signal)
      SIGNAL_SERVICE="${2:-}"
      shift 2
      ;;
    --gateway)
      GATEWAY_SERVICE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! [[ "$SAMPLES" =~ ^[0-9]+$ ]] || ! [[ "$INTERVAL" =~ ^[0-9]+$ ]]; then
  echo "--samples and --interval must be non-negative integers" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Avoid noisy docker compose warnings when these optional vars are unset.
export CLAUDE_AI_SESSION_KEY="${CLAUDE_AI_SESSION_KEY-}"
export CLAUDE_WEB_SESSION_KEY="${CLAUDE_WEB_SESSION_KEY-}"
export CLAUDE_WEB_COOKIE="${CLAUDE_WEB_COOKIE-}"

echo "== Signal About ($(date -u +%Y-%m-%dT%H:%M:%SZ)) =="
docker compose exec -T "${GATEWAY_SERVICE}" sh -lc "curl -sS http://${SIGNAL_SERVICE}:8080/v1/about || true"
echo

signal_cid="$(docker compose ps -q "${SIGNAL_SERVICE}")"
gateway_cid="$(docker compose ps -q "${GATEWAY_SERVICE}")"
if [[ -z "${signal_cid}" || -z "${gateway_cid}" ]]; then
  echo "Could not resolve container IDs for services: ${SIGNAL_SERVICE}, ${GATEWAY_SERVICE}" >&2
  exit 1
fi

echo "== CPU/Memory Samples (${SAMPLES}x every ${INTERVAL}s) =="
for _ in $(seq 1 "${SAMPLES}"); do
  printf "%s " "$(date +%H:%M:%S)"
  docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.PIDs}}" "${signal_cid}" "${gateway_cid}" \
    | tr '\n' '|' || true
  echo
  sleep "${INTERVAL}"
done
echo

echo "== Signal Logs (${SINCE}) =="
docker compose logs --since "${SINCE}" "${SIGNAL_SERVICE}" \
  | rg -n 'GET\s+"/v1/receive|Config file is in use|lock acquired|ERROR|WARN' \
  | tail -n 120 || true
echo

echo "== Gateway Signal Errors (${SINCE}) =="
docker compose logs --since "${SINCE}" "${GATEWAY_SERVICE}" \
  | rg -n '\[signal\].*(error|failed|timeout|lost)|Signal receive failed|non-JSON payload|Signal REST send timed out|lane wait exceeded' \
  | tail -n 120 || true
