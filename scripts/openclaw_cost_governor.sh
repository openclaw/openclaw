#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${OPENCLAW_SAFE_ENV_FILE:-$ROOT_DIR/.env.safe}"
STATE_FILE="${OPENCLAW_COST_GOVERNOR_STATE:-$ROOT_DIR/.cost-governor-state.json}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd python3

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

compose_cli() {
  docker compose --env-file "$ENV_FILE" run --rm openclaw-cli "$@"
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/openclaw_cost_governor.sh status
  ./scripts/openclaw_cost_governor.sh mode <free|hybrid|burst> [--yes]
  ./scripts/openclaw_cost_governor.sh escalate --reason "<text>" --est-usd <amount> --cap-usd <amount> [--mode burst|hybrid] [--yes]
  ./scripts/openclaw_cost_governor.sh deescalate [--yes]
  ./scripts/openclaw_cost_governor.sh quality-check --free-score <0..1> --paid-score <0..1> [--threshold 0.20] [--yes]

Modes:
  free    Local/free-first. Paid web fallbacks disabled.
  hybrid  Free-first search, paid-capable routing retained but constrained.
  burst   Paid search rail enabled for deeper retrieval (approval expected before switching).
EOF
}

confirm_or_exit() {
  local prompt="$1"
  local assume_yes="$2"
  if [[ "$assume_yes" == "yes" ]]; then
    return 0
  fi
  read -r -p "$prompt (type CONFIRM): " reply
  if [[ "$reply" != "CONFIRM" ]]; then
    echo "Aborted."
    exit 1
  fi
}

write_state() {
  local mode="$1"
  local reason="$2"
  local est_usd="$3"
  local cap_usd="$4"
  python3 - "$STATE_FILE" "$mode" "$reason" "$est_usd" "$cap_usd" <<'PY'
import json, pathlib, sys, datetime
path = pathlib.Path(sys.argv[1])
payload = {
    "updated_at_utc": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
    "mode": sys.argv[2],
    "reason": sys.argv[3],
    "estimated_incremental_usd": sys.argv[4],
    "escalation_cap_usd": sys.argv[5],
}
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(f"state_saved={path}")
PY
}

apply_common() {
  compose_cli config set agents.defaults.heartbeat.every "0m"
  compose_cli config set agents.defaults.heartbeat.target "none"
  compose_cli config set agents.defaults.contextPruning.mode "cache-ttl"
  compose_cli config set agents.defaults.contextPruning.ttl "5m"
  compose_cli config set agents.defaults.contextPruning.keepLastAssistants 3
  compose_cli config set agents.defaults.maxConcurrent 2
  compose_cli config set agents.defaults.subagents.maxConcurrent 1
  compose_cli config set agents.defaults.subagents.maxChildrenPerAgent 2
  compose_cli config set tools.loopDetection.enabled true
  compose_cli config set tools.loopDetection.historySize 30
  compose_cli config set tools.loopDetection.warningThreshold 8
  compose_cli config set tools.loopDetection.criticalThreshold 14
  compose_cli config set tools.loopDetection.globalCircuitBreakerThreshold 22
  compose_cli config set tools.web.fetch.enabled true
  compose_cli config set tools.web.fetch.maxCharsCap 8000
  compose_cli config set tools.web.fetch.timeoutSeconds 15
  compose_cli config set tools.web.fetch.cacheTtlMinutes 1
}

apply_mode_free() {
  apply_common
  compose_cli config set agents.defaults.model.primary "ollama/qwen2.5-coder:7b"
  compose_cli config set agents.defaults.model.fallbacks '["ollama/llama3.2:3b"]'
  compose_cli config set tools.web.search.enabled true
  compose_cli config set tools.web.search.provider "brave"
  compose_cli config unset tools.web.search.perplexity || true
  compose_cli config set tools.web.search.maxResults 8
  compose_cli config set tools.web.search.timeoutSeconds 12
  compose_cli config set tools.web.search.cacheTtlMinutes 1
}

apply_mode_hybrid() {
  apply_common
  compose_cli config set agents.defaults.model.primary "ollama/qwen2.5-coder:7b"
  compose_cli config set agents.defaults.model.fallbacks '["ollama/llama3.2:3b"]'
  compose_cli config set tools.web.search.enabled true
  compose_cli config set tools.web.search.provider "brave"
  compose_cli config set tools.web.search.maxResults 10
  compose_cli config set tools.web.search.timeoutSeconds 15
  compose_cli config set tools.web.search.cacheTtlMinutes 1
}

apply_mode_burst() {
  apply_common
  compose_cli config set agents.defaults.model.primary "ollama/qwen2.5-coder:7b"
  compose_cli config set agents.defaults.model.fallbacks '["ollama/llama3.2:3b"]'
  compose_cli config set tools.web.search.enabled true
  compose_cli config set tools.web.search.provider "perplexity"
  compose_cli config set tools.web.search.perplexity.baseUrl "https://openrouter.ai/api/v1"
  compose_cli config set tools.web.search.perplexity.model "perplexity/sonar-pro"
  compose_cli config set tools.web.search.maxResults 10
  compose_cli config set tools.web.search.timeoutSeconds 20
  compose_cli config set tools.web.search.cacheTtlMinutes 1
}

restart_gateway() {
  docker compose --env-file "$ENV_FILE" restart openclaw-gateway >/dev/null
  echo "gateway_restarted=true"
}

print_status() {
  echo "mode_state_file=$STATE_FILE"
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  else
    echo "mode_state_file_missing=true"
  fi
  echo ""
  echo "[live config]"
  compose_cli config get agents.defaults.model
  compose_cli config get agents.defaults.heartbeat
  compose_cli config get agents.defaults.contextPruning
  compose_cli config get agents.defaults.subagents
  compose_cli config get tools.web.search
  compose_cli config get tools.web.fetch
}

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  usage
  exit 1
fi
shift || true

case "$cmd" in
  status)
    print_status
    ;;
  mode)
    mode="${1:-}"
    shift || true
    assume="no"
    [[ "${1:-}" == "--yes" ]] && assume="yes"
    case "$mode" in
      free|hybrid|burst) ;;
      *) usage; exit 1 ;;
    esac
    confirm_or_exit "Apply cost-governor mode '$mode'?" "$assume"
    "apply_mode_${mode}"
    restart_gateway
    write_state "$mode" "manual mode switch" "n/a" "n/a"
    echo "mode_applied=$mode"
    ;;
  escalate)
    reason=""
    est_usd=""
    cap_usd=""
    mode="burst"
    assume="no"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --reason) reason="${2:-}"; shift 2 ;;
        --est-usd) est_usd="${2:-}"; shift 2 ;;
        --cap-usd) cap_usd="${2:-}"; shift 2 ;;
        --mode) mode="${2:-}"; shift 2 ;;
        --yes) assume="yes"; shift ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    [[ -z "$reason" || -z "$est_usd" || -z "$cap_usd" ]] && { usage; exit 1; }
    [[ "$mode" != "burst" && "$mode" != "hybrid" ]] && { echo "escalate mode must be burst or hybrid" >&2; exit 1; }
    echo "Escalation request:"
    echo "  reason=$reason"
    echo "  estimated_incremental_usd=$est_usd"
    echo "  escalation_cap_usd=$cap_usd"
    echo "  target_mode=$mode"
    confirm_or_exit "Approve paid escalation?" "$assume"
    "apply_mode_${mode}"
    restart_gateway
    write_state "$mode" "$reason" "$est_usd" "$cap_usd"
    echo "escalation_approved=true"
    ;;
  deescalate)
    assume="no"
    [[ "${1:-}" == "--yes" ]] && assume="yes"
    confirm_or_exit "De-escalate to FREE mode?" "$assume"
    apply_mode_free
    restart_gateway
    write_state "free" "manual de-escalation" "n/a" "n/a"
    echo "deescalated=true"
    ;;
  quality-check)
    free_score=""
    paid_score=""
    threshold="0.20"
    assume="no"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --free-score) free_score="${2:-}"; shift 2 ;;
        --paid-score) paid_score="${2:-}"; shift 2 ;;
        --threshold) threshold="${2:-}"; shift 2 ;;
        --yes) assume="yes"; shift ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    [[ -z "$free_score" || -z "$paid_score" ]] && { usage; exit 1; }
    severe_drop="$(python3 - "$free_score" "$paid_score" "$threshold" <<'PY'
import sys
free=float(sys.argv[1]); paid=float(sys.argv[2]); th=float(sys.argv[3])
print("yes" if (paid-free) >= th else "no")
PY
)"
    if [[ "$severe_drop" == "yes" ]]; then
      echo "quality_drop_severe=true"
      echo "free_score=$free_score paid_score=$paid_score threshold=$threshold"
      confirm_or_exit "Quality dropped severely after de-escalation. Approve re-escalation to BURST?" "$assume"
      apply_mode_burst
      restart_gateway
      write_state "burst" "quality exception re-escalation" "n/a" "n/a"
      echo "re_escalated=true"
    else
      echo "quality_drop_severe=false"
      apply_mode_free
      restart_gateway
      write_state "free" "quality acceptable on free mode" "n/a" "n/a"
      echo "stayed_free=true"
    fi
    ;;
  *)
    usage
    exit 1
    ;;
esac
