#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CONTEXT="${CONTEXT:-dev-morpho}"
NAMESPACE="${NAMESPACE:-monitoring}"
AWS_REGION="${AWS_REGION:-eu-west-3}"
ECR_REPO="${ECR_REPO:-openclaw-sre}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
IMAGE_PLATFORM="${IMAGE_PLATFORM:-linux/amd64}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.2.24}"
OPENCLAW_INSTALL_SOURCE="${OPENCLAW_INSTALL_SOURCE:-local}"
OPENCLAW_LOCAL_BUILD="${OPENCLAW_LOCAL_BUILD:-0}"
DEPLOY_ENV="${DEPLOY_ENV:-dev}"

OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"
SLACK_ENV_FILE="${SLACK_ENV_FILE:-$HOME/.openclaw/docker-sre/.env}"
SLACK_TXT_FILE="${SLACK_TXT_FILE:-$ROOT_DIR/slack.txt}"
GRAFANA_TXT_FILE="${GRAFANA_TXT_FILE:-$ROOT_DIR/grafana.txt}"
BETTERSTACK_TXT_FILE="${BETTERSTACK_TXT_FILE:-$ROOT_DIR/betterstack.txt}"
DEFAULT_SKILL_DIR="$ROOT_DIR/deploy/skills/morpho-sre"
if [[ -d "$DEFAULT_SKILL_DIR" ]]; then
  SKILL_DIR="${SKILL_DIR:-$DEFAULT_SKILL_DIR}"
else
  SKILL_DIR="${SKILL_DIR:-$HOME/.openclaw/skills/morpho-sre}"
fi
MORPHO_INFRA_DIR="${MORPHO_INFRA_DIR:-/Users/florian/morpho/morpho-infra}"
MORPHO_INFRA_HELM_DIR="${MORPHO_INFRA_HELM_DIR:-/Users/florian/morpho/morpho-infra-helm}"
DEFAULT_HELM_CHART_DIR="$ROOT_DIR/deploy/eks/charts/openclaw-sre"
if [[ -d "$MORPHO_INFRA_HELM_DIR/charts/openclaw-sre" ]]; then
  DEFAULT_HELM_CHART_DIR="$MORPHO_INFRA_HELM_DIR/charts/openclaw-sre"
fi
HELM_CHART_DIR="${HELM_CHART_DIR:-$DEFAULT_HELM_CHART_DIR}"
HELM_RELEASE="${HELM_RELEASE:-openclaw-sre}"
DEPLOY_REPLICAS="${DEPLOY_REPLICAS:-1}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-incident-readonly-agent}"
SERVICE_ACCOUNT_CREATE="${SERVICE_ACCOUNT_CREATE:-true}"
INCIDENT_READONLY_ROLE_ARN="${INCIDENT_READONLY_ROLE_ARN:-}"
VAULT_SECRETS_PATH="${VAULT_SECRETS_PATH:-secret/data/openclaw-sre/all-secrets}"
VAULT_K8S_SECRET_NAME="${VAULT_K8S_SECRET_NAME:-openclaw-sre-vault-secrets}"
RUNTIME_DOCKERFILE="${RUNTIME_DOCKERFILE:-$ROOT_DIR/deploy/eks/Dockerfile.runtime}"
INJECT_AWS_CREDS="${INJECT_AWS_CREDS:-0}"
INCLUDE_MORPHO_INFRA_PROJECTS="${INCLUDE_MORPHO_INFRA_PROJECTS:-0}"
SLACK_ALLOWED_USER_IDS="${SLACK_ALLOWED_USER_IDS:-U07KE3NALTX,*}"
SLACK_ALLOWED_CHANNEL_IDS="${SLACK_ALLOWED_CHANNEL_IDS:-}"
SRE_BETTERSTACK_ALERT_CHANNELS="${SRE_BETTERSTACK_ALERT_CHANNELS:-#staging-infra-monitoring,#public-api-monitoring,#platform-monitoring}"
SLACK_CHANNEL_REPLY_TO_MODE="${SLACK_CHANNEL_REPLY_TO_MODE:-all}"
SLACK_DM_POLICY="${SLACK_DM_POLICY:-open}"
SLACK_CHANNEL_POLICY="${SLACK_CHANNEL_POLICY:-open}"
TOOLS_PROFILE="${TOOLS_PROFILE:-coding}"
TOOLS_DENY="${TOOLS_DENY:-gateway,nodes}"
EXEC_SAFE_BINS="${EXEC_SAFE_BINS:-jq,cut,uniq,head,tail,tr,wc}"
EXEC_ALLOWLIST="${EXEC_ALLOWLIST:-/home/node/.openclaw/skills/morpho-sre/scripts/*.sh,/usr/bin/bash,/usr/bin/sh,/usr/bin/aws,/usr/bin/curl,/usr/bin/git,/usr/bin/gh,/usr/bin/jq,/usr/bin/sed,/usr/bin/awk,/usr/bin/grep,/usr/bin/sort,/usr/bin/cat,/usr/bin/head,/usr/bin/tail,/usr/bin/cut,/usr/bin/uniq,/usr/bin/tr,/usr/bin/wc,/usr/bin/xargs,/usr/bin/timeout,/usr/bin/tar,/usr/bin/unzip,/usr/bin/gzip,/usr/local/bin/kubectl,/usr/local/bin/helm,/usr/local/bin/argocd,/usr/local/bin/vault}"
ENABLE_SRE_SUBAGENTS="${ENABLE_SRE_SUBAGENTS:-1}"
ENABLE_HEARTBEAT="${ENABLE_HEARTBEAT:-1}"
ENABLE_SRE_SENTINEL_MODE="${ENABLE_SRE_SENTINEL_MODE:-1}"
SENTINEL_HEARTBEAT_EVERY="${SENTINEL_HEARTBEAT_EVERY:-30m}"
SENTINEL_HEARTBEAT_TARGET="${SENTINEL_HEARTBEAT_TARGET:-slack}"
SENTINEL_HEARTBEAT_TO="${SENTINEL_HEARTBEAT_TO:-channel:#staging-infra-monitoring}"
SENTINEL_HEARTBEAT_ACCOUNT_ID="${SENTINEL_HEARTBEAT_ACCOUNT_ID:-}"
SENTINEL_HEARTBEAT_ACTIVE_HOURS_START="${SENTINEL_HEARTBEAT_ACTIVE_HOURS_START:-00:00}"
SENTINEL_HEARTBEAT_ACTIVE_HOURS_END="${SENTINEL_HEARTBEAT_ACTIVE_HOURS_END:-24:00}"
SENTINEL_HEARTBEAT_ACTIVE_HOURS_TIMEZONE="${SENTINEL_HEARTBEAT_ACTIVE_HOURS_TIMEZONE:-user}"
SENTINEL_HEARTBEAT_ACK_MAX_CHARS="${SENTINEL_HEARTBEAT_ACK_MAX_CHARS:-30}"
SENTINEL_HEARTBEAT_SESSION="${SENTINEL_HEARTBEAT_SESSION:-sentinel-monitor}"
SENTINEL_ROUTE_TARGET_CRITICAL="${SENTINEL_ROUTE_TARGET_CRITICAL:-user:U07KE3NALTX}"
SENTINEL_ROUTE_TARGET_HIGH="${SENTINEL_ROUTE_TARGET_HIGH:-user:U07KE3NALTX}"
SENTINEL_ROUTE_TARGET_MEDIUM="${SENTINEL_ROUTE_TARGET_MEDIUM:-channel:#staging-infra-monitoring}"
SENTINEL_ROUTE_TARGET_LOW="${SENTINEL_ROUTE_TARGET_LOW:-channel:#staging-infra-monitoring}"
SENTINEL_ALERT_COOLDOWN_SECONDS="${SENTINEL_ALERT_COOLDOWN_SECONDS:-1800}"
SENTINEL_ALERT_MIN_INTERVAL_SECONDS="${SENTINEL_ALERT_MIN_INTERVAL_SECONDS:-3600}"
SRE_AGENT_IDS="${SRE_AGENT_IDS:-sre-k8s,sre-observability,sre-release}"
SRE_AUTO_PR_ENABLED="${SRE_AUTO_PR_ENABLED:-1}"
SRE_AUTO_PR_MIN_CONFIDENCE="${SRE_AUTO_PR_MIN_CONFIDENCE:-85}"
SRE_AUTO_PR_ALLOWED_REPOS="${SRE_AUTO_PR_ALLOWED_REPOS:-morpho-org/*}"
SRE_AUTO_PR_BRANCH_PREFIX="${SRE_AUTO_PR_BRANCH_PREFIX:-openclaw/sre-auto}"
SRE_AUTO_PR_NOTIFY_ENABLED="${SRE_AUTO_PR_NOTIFY_ENABLED:-1}"
SRE_AUTO_PR_NOTIFY_USER_ID="${SRE_AUTO_PR_NOTIFY_USER_ID:-}"
SRE_AUTO_PR_NOTIFY_STRICT="${SRE_AUTO_PR_NOTIFY_STRICT:-1}"
BETTERSTACK_API_BASE="${BETTERSTACK_API_BASE:-https://uptime.betterstack.com/api/v2}"
BETTERSTACK_ALLOWED_HOST="${BETTERSTACK_ALLOWED_HOST:-uptime.betterstack.com}"
BETTERSTACK_TEAM_ID="${BETTERSTACK_TEAM_ID:-}"
BETTERSTACK_TEAM_NAME="${BETTERSTACK_TEAM_NAME:-}"
GITHUB_REQUIRED_REPO="${GITHUB_REQUIRED_REPO:-morpho-org/morpho-infra}"
GITHUB_REQUIRED_ACTIONS_REPO="${GITHUB_REQUIRED_ACTIONS_REPO:-$GITHUB_REQUIRED_REPO}"
GITHUB_AUTH_STRICT="${GITHUB_AUTH_STRICT:-1}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus-stack-kube-prom-prometheus.monitoring:9090}"
SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev,monitoring}"
INCIDENT_STATE_DIR="${INCIDENT_STATE_DIR:-/home/node/.openclaw/state/sentinel}"
COST_REPORT_TARGET="${COST_REPORT_TARGET:-channel:#staging-infra-monitoring}"
SELF_IMPROVE_CRON_ENABLED="${SELF_IMPROVE_CRON_ENABLED:-true}"
SELF_IMPROVE_CRON_SCHEDULE="${SELF_IMPROVE_CRON_SCHEDULE:-17 4 * * *}"
SELF_IMPROVE_REPO="${SELF_IMPROVE_REPO:-morpho-org/openclaw-sre}"
SELF_IMPROVE_BASE_BRANCH="${SELF_IMPROVE_BASE_BRANCH:-main}"
SELF_IMPROVE_LOOKBACK_HOURS="${SELF_IMPROVE_LOOKBACK_HOURS:-24}"
SELF_IMPROVE_CONFIDENCE="${SELF_IMPROVE_CONFIDENCE:-92}"
SELF_IMPROVE_BRANCH_PREFIX="${SELF_IMPROVE_BRANCH_PREFIX:-openclaw/sre-self-improve}"
RCA_MODE="${RCA_MODE:-single}"
SERVICE_CONTEXT_ENABLED="${SERVICE_CONTEXT_ENABLED:-1}"
RCA_CHAIN_ENABLED="${RCA_CHAIN_ENABLED:-1}"
RCA_CHAIN_STAGE_E_ENABLED="${RCA_CHAIN_STAGE_E_ENABLED:-1}"
INCIDENT_LEARNING_ENABLED="${INCIDENT_LEARNING_ENABLED:-1}"
RCA_CHAIN_TOTAL_TIMEOUT_MS="${RCA_CHAIN_TOTAL_TIMEOUT_MS:-60000}"
RCA_STAGE_TIMEOUT_MS="${RCA_STAGE_TIMEOUT_MS:-10000}"
RCA_EVIDENCE_TOTAL_TIMEOUT_MS="${RCA_EVIDENCE_TOTAL_TIMEOUT_MS:-80000}"
RCA_MIN_RERUN_INTERVAL_S="${RCA_MIN_RERUN_INTERVAL_S:-3600}"
RCA_CHAIN_COST_ALERT_THRESHOLD="${RCA_CHAIN_COST_ALERT_THRESHOLD:-750}"
RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS="${RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS:-20}"
BOT_MODEL_PRIMARY="${BOT_MODEL_PRIMARY:-openai-codex/gpt-5.3-codex}"
BOT_MODEL_FALLBACKS="${BOT_MODEL_FALLBACKS:-anthropic/claude-opus-4-6}"

case "$DEPLOY_ENV" in
  dev)
    INCIDENT_ROLE_ENV="dev"
    DEFAULT_GRAFANA_BASE_URL="https://monitoring-dev.morpho.dev"
    DEFAULT_GRAFANA_ALLOWED_HOST="monitoring-dev.morpho.dev"
    GRAFANA_TOKEN_KEYS="token dev_token"
    ;;
  prod)
    INCIDENT_ROLE_ENV="prd"
    DEFAULT_GRAFANA_BASE_URL="https://monitoring.morpho.dev"
    DEFAULT_GRAFANA_ALLOWED_HOST="monitoring.morpho.dev"
    GRAFANA_TOKEN_KEYS="prd_token prod_token token_prd token_prod production_token"
    ;;
  *)
    echo "Unsupported DEPLOY_ENV: $DEPLOY_ENV (expected: dev|prod)" >&2
    exit 1
    ;;
esac

GRAFANA_BASE_URL="${GRAFANA_BASE_URL:-$DEFAULT_GRAFANA_BASE_URL}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

trim_trailing_eol() {
  printf '%s' "$1" | tr -d '\r'
}

trim_var_in_place() {
  local var_name="$1"
  local raw="${!var_name-}"
  local trimmed
  trimmed="$(trim_trailing_eol "$raw")"
  printf -v "$var_name" '%s' "$trimmed"
}

require_secret_keys() {
  local secret_name="$1"
  shift
  local secret_json
  secret_json="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret "$secret_name" -o json)"
  local missing=()
  local key
  for key in "$@"; do
    if ! printf '%s' "$secret_json" | jq -e --arg k "$key" '.data[$k] // empty | length > 0' >/dev/null; then
      missing+=("$key")
    fi
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    printf 'Missing required keys in %s/%s: %s\n' "$NAMESPACE" "$secret_name" "${missing[*]}" >&2
    exit 1
  fi
}

for cmd in aws docker helm jq kubectl mktemp rsync sed vault; do
  require_cmd "$cmd"
done

case "$OPENCLAW_INSTALL_SOURCE" in
  local|npm)
    ;;
  *)
    echo "OPENCLAW_INSTALL_SOURCE must be local or npm (got: $OPENCLAW_INSTALL_SOURCE)" >&2
    exit 1
    ;;
esac

if [[ "$OPENCLAW_INSTALL_SOURCE" == "local" ]]; then
  require_cmd npm
  require_cmd pnpm
fi

for path in \
  "$OPENCLAW_JSON" \
  "$SLACK_ENV_FILE" \
  "$SKILL_DIR/SKILL.md" \
  "$SKILL_DIR/HEARTBEAT.md" \
  "$SKILL_DIR/references/repo-map.md" \
  "$SKILL_DIR/scripts/image-repo-map.sh" \
  "$SKILL_DIR/scripts/grafana-api.sh" \
  "$SKILL_DIR/scripts/betterstack-api.sh" \
  "$SKILL_DIR/scripts/repo-clone.sh" \
  "$SKILL_DIR/scripts/github-ci-status.sh" \
  "$SKILL_DIR/scripts/autofix-pr.sh" \
  "$SKILL_DIR/scripts/sentinel-triage.sh" \
  "$SKILL_DIR/scripts/prometheus-trends.sh" \
  "$SKILL_DIR/scripts/argocd-sync-status.sh" \
  "$SKILL_DIR/scripts/cert-secret-health.sh" \
  "$SKILL_DIR/scripts/aws-resource-signals.sh" \
  "$SKILL_DIR/scripts/aws-cost-report.sh" \
  "$SKILL_DIR/scripts/self-improve-pr.sh" \
  "$SKILL_DIR/scripts/sentinel-snapshot.sh" \
  "$SKILL_DIR/scripts/lib-incident-id.sh" \
  "$SKILL_DIR/scripts/lib-state-file.sh" \
  "$SKILL_DIR/scripts/lib-continuity-matcher.sh" \
  "$SKILL_DIR/scripts/lib-outbox.sh" \
  "$SKILL_DIR/scripts/lib-linear-preflight.sh" \
  "$SKILL_DIR/scripts/lib-linear-ticket.sh" \
  "$SKILL_DIR/scripts/lib-rca-prompt.sh" \
  "$SKILL_DIR/scripts/lib-rca-llm.sh" \
  "$SKILL_DIR/scripts/lib-rca-crossreview.sh" \
  "$SKILL_DIR/scripts/lib-rca-safety.sh" \
  "$SKILL_DIR/scripts/lib-thread-archival.sh" \
  "$SKILL_DIR/scripts/lib-meta-alerts.sh" \
  "$SKILL_DIR/scripts/linear-memory-lookup.sh" \
  "$SKILL_DIR/scripts/lib-service-graph.sh" \
  "$SKILL_DIR/scripts/relationship-knowledge-build.sh" \
  "$SKILL_DIR/scripts/lib-service-overlay.sh" \
  "$SKILL_DIR/scripts/lib-incident-memory.sh" \
  "$SKILL_DIR/scripts/lib-service-context.sh" \
  "$SKILL_DIR/scripts/lib-rca-chain.sh" \
  "$SKILL_DIR/scripts/lib-rca-sink.sh" \
  "$SKILL_DIR/scripts/lib-overlay-suggestions.sh" \
  "$SKILL_DIR/rca_hypothesis_ids.v1.json" \
  "$SKILL_DIR/references/safety.md" \
  "$MORPHO_INFRA_DIR" \
  "$MORPHO_INFRA_HELM_DIR" \
  "$HELM_CHART_DIR/Chart.yaml" \
  "$RUNTIME_DOCKERFILE"; do
  if [[ ! -e "$path" ]]; then
    echo "Missing path: $path" >&2
    exit 1
  fi
done

copy_skill_dir() {
  local src="$1"
  local name
  name="$(basename "$src")"
  if [[ ! -f "$src/SKILL.md" ]]; then
    return 0
  fi
  if [[ -d "$SKILL_BUNDLE_SKILLS_DIR/$name" ]]; then
    return 0
  fi
  mkdir -p "$SKILL_BUNDLE_SKILLS_DIR/$name"
  rsync -a --exclude '.git' "$src/" "$SKILL_BUNDLE_SKILLS_DIR/$name/"
  echo "  + $name"
}

read_kv_value() {
  local file="$1"
  local key="$2"
  awk -F= -v want="$key" '
    function trim(s) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)
      return s
    }
    {
      k = tolower(trim($1))
      v = substr($0, index($0, "=") + 1)
      v = trim(v)
      gsub(/^"|"$/, "", v)
      if (k == tolower(want)) {
        print v
        exit
      }
    }
  ' "$file" || true
}

to_json_array() {
  local raw="${1:-}"
  printf '%s' "$raw" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }' \
    | jq -Rsc 'split("\n") | map(select(length > 0))'
}

safe_bin_profiles_json() {
  local raw="${1:-}"
  printf '%s' "$raw" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }' \
    | jq -Rsc 'split("\n") | map(select(length > 0)) | unique | reduce .[] as $bin ({}; .[$bin] = {})'
}

bool_to_json() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

normalize_slack_target() {
  local raw="${1:-}"
  local trimmed
  trimmed="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  if [[ -z "$trimmed" ]]; then
    printf '\n'
    return
  fi
  case "$trimmed" in
    user:*|channel:*|slack:*|@*|\#*)
      printf '%s\n' "$trimmed"
      ;;
    U*|W*)
      printf 'user:%s\n' "$trimmed"
      ;;
    C*|D*|G*)
      printf 'channel:%s\n' "$trimmed"
      ;;
    *)
      printf '%s\n' "$trimmed"
      ;;
  esac
}

set -a
# shellcheck disable=SC1090
source "$SLACK_ENV_FILE"
set +a

if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  if [[ -f "$SLACK_TXT_FILE" ]]; then
    SLACK_BOT_TOKEN="$(grep -Eo 'xoxb-[A-Za-z0-9-]+' "$SLACK_TXT_FILE" | head -n1 || true)"
  fi
fi

if [[ "${SLACK_APP_TOKEN:-}" == "http-mode-unused" ]]; then
  SLACK_APP_TOKEN=""
fi

if [[ "${SLACK_APP_TOKEN:-}" != xapp-* && -f "$SLACK_TXT_FILE" ]]; then
  SLACK_APP_TOKEN="$(grep -Eo 'xapp-[A-Za-z0-9-]+' "$SLACK_TXT_FILE" | head -n1 || true)"
fi

if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  echo "SLACK_BOT_TOKEN missing in $SLACK_ENV_FILE (and no xoxb token found in $SLACK_TXT_FILE)" >&2
  exit 1
fi

if [[ -z "${SLACK_APP_TOKEN:-}" || "${SLACK_APP_TOKEN:-}" != xapp-* ]]; then
  echo "SLACK_APP_TOKEN missing in $SLACK_ENV_FILE (and no xapp token found in $SLACK_TXT_FILE)" >&2
  exit 1
fi

if [[ -z "${GRAFANA_TOKEN:-}" && -f "$GRAFANA_TXT_FILE" ]]; then
  for key in $GRAFANA_TOKEN_KEYS; do
    GRAFANA_TOKEN="$(read_kv_value "$GRAFANA_TXT_FILE" "$key")"
    if [[ -n "${GRAFANA_TOKEN:-}" ]]; then
      break
    fi
  done
fi

if [[ -z "${GRAFANA_TOKEN:-}" ]]; then
  echo "GRAFANA_TOKEN missing for DEPLOY_ENV=$DEPLOY_ENV (set env or one of: $GRAFANA_TOKEN_KEYS in $GRAFANA_TXT_FILE)" >&2
  exit 1
fi

if [[ -z "${BETTERSTACK_API_TOKEN:-}" && -f "$BETTERSTACK_TXT_FILE" ]]; then
  for key in api_token betterstack_api_token token; do
    BETTERSTACK_API_TOKEN="$(read_kv_value "$BETTERSTACK_TXT_FILE" "$key")"
    if [[ -n "${BETTERSTACK_API_TOKEN:-}" ]]; then
      break
    fi
  done
fi

if [[ -f "$BETTERSTACK_TXT_FILE" ]]; then
  if [[ "$BETTERSTACK_API_BASE" == "https://uptime.betterstack.com/api/v2" ]]; then
    for key in api_base betterstack_api_base base_url api_url; do
      maybe_base="$(read_kv_value "$BETTERSTACK_TXT_FILE" "$key")"
      if [[ -n "$maybe_base" ]]; then
        BETTERSTACK_API_BASE="$maybe_base"
        break
      fi
    done
  fi
  if [[ -z "$BETTERSTACK_TEAM_ID" ]]; then
    for key in team_id betterstack_team_id; do
      maybe_team_id="$(read_kv_value "$BETTERSTACK_TXT_FILE" "$key")"
      if [[ -n "$maybe_team_id" ]]; then
        BETTERSTACK_TEAM_ID="$maybe_team_id"
        break
      fi
    done
  fi
  if [[ -z "$BETTERSTACK_TEAM_NAME" ]]; then
    for key in team_name betterstack_team_name; do
      maybe_team_name="$(read_kv_value "$BETTERSTACK_TXT_FILE" "$key")"
      if [[ -n "$maybe_team_name" ]]; then
        BETTERSTACK_TEAM_NAME="$maybe_team_name"
        break
      fi
    done
  fi
fi

if [[ -z "${BETTERSTACK_API_TOKEN:-}" ]]; then
  echo "BETTERSTACK_API_TOKEN missing (set env or api_token in $BETTERSTACK_TXT_FILE)" >&2
  exit 1
fi

if [[ -z "$SENTINEL_HEARTBEAT_TO" ]]; then
  SLACK_PRIMARY_USER_ID="$(
    printf '%s' "$SLACK_ALLOWED_USER_IDS" \
      | tr ',' '\n' \
      | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
      | awk 'NF > 0 { print; exit }'
  )"
  if [[ -n "$SLACK_PRIMARY_USER_ID" ]]; then
    SENTINEL_HEARTBEAT_TO="user:${SLACK_PRIMARY_USER_ID}"
  fi
fi

if [[ -z "${SLACK_PRIMARY_USER_ID:-}" ]]; then
  SLACK_PRIMARY_USER_ID="$(
    printf '%s' "$SLACK_ALLOWED_USER_IDS" \
      | tr ',' '\n' \
      | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
      | awk 'NF > 0 { print; exit }'
  )"
fi

if [[ -z "$SRE_AUTO_PR_NOTIFY_USER_ID" && -n "${SLACK_PRIMARY_USER_ID:-}" ]]; then
  SRE_AUTO_PR_NOTIFY_USER_ID="$SLACK_PRIMARY_USER_ID"
fi

if [[ "$SENTINEL_HEARTBEAT_TARGET" == "slack" ]]; then
  SENTINEL_HEARTBEAT_TO="$(normalize_slack_target "$SENTINEL_HEARTBEAT_TO")"
  SENTINEL_ROUTE_TARGET_CRITICAL="$(normalize_slack_target "$SENTINEL_ROUTE_TARGET_CRITICAL")"
  SENTINEL_ROUTE_TARGET_HIGH="$(normalize_slack_target "$SENTINEL_ROUTE_TARGET_HIGH")"
  SENTINEL_ROUTE_TARGET_MEDIUM="$(normalize_slack_target "$SENTINEL_ROUTE_TARGET_MEDIUM")"
  SENTINEL_ROUTE_TARGET_LOW="$(normalize_slack_target "$SENTINEL_ROUTE_TARGET_LOW")"
fi

if [[ "$(bool_to_json "$ENABLE_SRE_SENTINEL_MODE")" == "true" && "$SENTINEL_HEARTBEAT_TARGET" == "slack" && -z "$SENTINEL_HEARTBEAT_TO" ]]; then
  echo "SENTINEL_HEARTBEAT_TO is required when SENTINEL_HEARTBEAT_TARGET=slack (set user:<id> or channel:<id>)" >&2
  exit 1
fi

if ! [[ "$SENTINEL_HEARTBEAT_ACK_MAX_CHARS" =~ ^[0-9]+$ ]]; then
  echo "SENTINEL_HEARTBEAT_ACK_MAX_CHARS must be a non-negative integer: $SENTINEL_HEARTBEAT_ACK_MAX_CHARS" >&2
  exit 1
fi

if ! [[ "$SENTINEL_ALERT_COOLDOWN_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "SENTINEL_ALERT_COOLDOWN_SECONDS must be a non-negative integer: $SENTINEL_ALERT_COOLDOWN_SECONDS" >&2
  exit 1
fi

if ! [[ "$SENTINEL_ALERT_MIN_INTERVAL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "SENTINEL_ALERT_MIN_INTERVAL_SECONDS must be a non-negative integer: $SENTINEL_ALERT_MIN_INTERVAL_SECONDS" >&2
  exit 1
fi

case "$RCA_MODE" in
  single|dual|heuristic)
    ;;
  *)
    echo "RCA_MODE must be one of: single|dual|heuristic (got: $RCA_MODE)" >&2
    exit 1
    ;;
esac

if ! [[ "$SRE_AUTO_PR_MIN_CONFIDENCE" =~ ^[0-9]+$ ]] || [[ "$SRE_AUTO_PR_MIN_CONFIDENCE" -lt 0 || "$SRE_AUTO_PR_MIN_CONFIDENCE" -gt 100 ]]; then
  echo "SRE_AUTO_PR_MIN_CONFIDENCE must be an integer in [0,100]: $SRE_AUTO_PR_MIN_CONFIDENCE" >&2
  exit 1
fi

case "$SLACK_CHANNEL_REPLY_TO_MODE" in
  off|first|all)
    ;;
  *)
    echo "SLACK_CHANNEL_REPLY_TO_MODE must be one of: off|first|all (got: $SLACK_CHANNEL_REPLY_TO_MODE)" >&2
    exit 1
    ;;
esac

if [[ "$(bool_to_json "$SRE_AUTO_PR_NOTIFY_ENABLED")" == "true" && -z "$SRE_AUTO_PR_NOTIFY_USER_ID" ]]; then
  echo "SRE_AUTO_PR_NOTIFY_USER_ID is required when SRE_AUTO_PR_NOTIFY_ENABLED=1" >&2
  exit 1
fi

if ! [[ "$DEPLOY_REPLICAS" =~ ^[0-9]+$ ]]; then
  echo "DEPLOY_REPLICAS must be a non-negative integer: $DEPLOY_REPLICAS" >&2
  exit 1
fi
if [[ -z "$BOT_MODEL_PRIMARY" ]]; then
  echo "BOT_MODEL_PRIMARY must be non-empty" >&2
  exit 1
fi

SLACK_ALLOW_FROM_JSON="$(to_json_array "$SLACK_ALLOWED_USER_IDS")"
SLACK_CHANNEL_IDS_JSON="$(to_json_array "$SLACK_ALLOWED_CHANNEL_IDS")"
SLACK_BETTERSTACK_CHANNELS_JSON="$(to_json_array "$SRE_BETTERSTACK_ALERT_CHANNELS")"
BOT_MODEL_FALLBACKS_JSON="$(to_json_array "$BOT_MODEL_FALLBACKS")"
SLACK_CHANNEL_IDS_JSON="$(
  jq -cn \
    --argjson base "$SLACK_CHANNEL_IDS_JSON" \
    --argjson extra "$SLACK_BETTERSTACK_CHANNELS_JSON" \
    '($base + $extra) | map(tostring) | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | unique'
)"
TOOLS_DENY_JSON="$(to_json_array "$TOOLS_DENY")"
EXEC_SAFE_BINS_JSON="$(to_json_array "$EXEC_SAFE_BINS")"
EXEC_SAFE_BIN_PROFILES_JSON="$(safe_bin_profiles_json "$EXEC_SAFE_BINS")"
SRE_AGENT_IDS_JSON="$(to_json_array "$SRE_AGENT_IDS")"
ENABLE_SRE_SUBAGENTS_JSON="$(bool_to_json "$ENABLE_SRE_SUBAGENTS")"
ENABLE_HEARTBEAT_JSON="$(bool_to_json "$ENABLE_HEARTBEAT")"
ENABLE_SRE_SENTINEL_MODE_JSON="$(bool_to_json "$ENABLE_SRE_SENTINEL_MODE")"
if [[ "$SENTINEL_HEARTBEAT_TARGET" == "slack" ]]; then
  SENTINEL_ROUTE_ALLOWLIST_JSON="$(
    {
      printf '%s\n' "$SENTINEL_HEARTBEAT_TO"
      printf '%s\n' "$SENTINEL_ROUTE_TARGET_CRITICAL"
      printf '%s\n' "$SENTINEL_ROUTE_TARGET_HIGH"
      printf '%s\n' "$SENTINEL_ROUTE_TARGET_MEDIUM"
      printf '%s\n' "$SENTINEL_ROUTE_TARGET_LOW"
    } | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
      | awk 'NF > 0 { print }' \
      | jq -Rsc 'split("\n") | map(select(length > 0)) | unique'
  )"
else
  SENTINEL_ROUTE_ALLOWLIST_JSON="[]"
fi

GRAFANA_ALLOWED_HOST="${GRAFANA_ALLOWED_HOST:-$DEFAULT_GRAFANA_ALLOWED_HOST}"
GRAFANA_BASE_HOST="$(printf '%s' "$GRAFANA_BASE_URL" | sed -E 's#^https?://([^/]+).*$#\1#')"
if [[ "$GRAFANA_BASE_HOST" != "$GRAFANA_ALLOWED_HOST" ]]; then
  echo "GRAFANA_BASE_URL host mismatch: $GRAFANA_BASE_HOST (allowed: $GRAFANA_ALLOWED_HOST)" >&2
  exit 1
fi

if [[ "$DEPLOY_ENV" == "dev" && "${ENFORCE_DEV_GRAFANA_HOST:-1}" == "1" && "$GRAFANA_ALLOWED_HOST" != "monitoring-dev.morpho.dev" ]]; then
  echo "Blocked GRAFANA host for dev deploy: $GRAFANA_ALLOWED_HOST (expected monitoring-dev.morpho.dev)" >&2
  exit 1
fi
if [[ "$DEPLOY_ENV" == "prod" && "${ENFORCE_PROD_GRAFANA_HOST:-1}" == "1" && "$GRAFANA_ALLOWED_HOST" != "monitoring.morpho.dev" ]]; then
  echo "Blocked GRAFANA host for prod deploy: $GRAFANA_ALLOWED_HOST (expected monitoring.morpho.dev)" >&2
  exit 1
fi

BETTERSTACK_BASE_HOST="$(printf '%s' "$BETTERSTACK_API_BASE" | sed -E 's#^https?://([^/]+).*$#\1#')"
if [[ "$BETTERSTACK_BASE_HOST" != "$BETTERSTACK_ALLOWED_HOST" ]]; then
  echo "BETTERSTACK_API_BASE host mismatch: $BETTERSTACK_BASE_HOST (allowed: $BETTERSTACK_ALLOWED_HOST)" >&2
  exit 1
fi

GATEWAY_TOKEN="$(jq -r '.gateway.auth.token // empty' "$OPENCLAW_JSON")"
if [[ -z "$GATEWAY_TOKEN" || "$GATEWAY_TOKEN" == "null" ]]; then
  echo "gateway.auth.token missing in $OPENCLAW_JSON" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [[ -z "$INCIDENT_READONLY_ROLE_ARN" ]]; then
  INCIDENT_READONLY_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${INCIDENT_ROLE_ENV}-incident-readonly-agent-role"
fi
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

TMP_DIR="$(mktemp -d /tmp/openclaw-sre-eks-build.XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "[1/8] Build context at $TMP_DIR"
cp "$RUNTIME_DOCKERFILE" "$TMP_DIR/Dockerfile"

LOCAL_OPENCLAW_TARBALL="$TMP_DIR/openclaw-local.tgz"
if [[ "$OPENCLAW_INSTALL_SOURCE" == "local" ]]; then
  if [[ "$OPENCLAW_LOCAL_BUILD" == "1" ]]; then
    echo "      Build local OpenClaw package assets"
    (cd "$ROOT_DIR" && pnpm build && pnpm ui:build)
  fi
  pack_output="$(npm pack --silent --pack-destination "$TMP_DIR" "$ROOT_DIR")"
  pack_file="$(printf '%s\n' "$pack_output" | tail -n1)"
  if [[ -z "$pack_file" || ! -f "$TMP_DIR/$pack_file" ]]; then
    echo "Failed to create local OpenClaw package tarball via npm pack" >&2
    exit 1
  fi
  mv -f "$TMP_DIR/$pack_file" "$LOCAL_OPENCLAW_TARBALL"
  echo "      Using local OpenClaw package: $pack_file"
else
  : > "$LOCAL_OPENCLAW_TARBALL"
  echo "      Using npm OpenClaw package: $OPENCLAW_VERSION"
fi

mkdir -p "$TMP_DIR/morpho-infra" "$TMP_DIR/morpho-infra-helm"
mkdir -p "$TMP_DIR/morpho-infra/projects"

# Keep default context small: infra core + helm definitions.
rsync -a --delete \
  --exclude '.git' \
  --exclude '.terraform' \
  --exclude '.terragrunt-cache' \
  --exclude '*.tfstate' \
  --exclude '*.tfstate.*' \
  "$MORPHO_INFRA_DIR/infrastructure/" "$TMP_DIR/morpho-infra/infrastructure/"

for file in AGENTS.md README.md docs; do
  if [[ -e "$MORPHO_INFRA_DIR/$file" ]]; then
    rsync -a --exclude '.git' "$MORPHO_INFRA_DIR/$file" "$TMP_DIR/morpho-infra/"
  fi
done

if [[ -d "$MORPHO_INFRA_DIR/projects/commons" ]]; then
  rsync -a \
    --exclude '.git' \
    --exclude '.terraform' \
    --exclude '.terragrunt-cache' \
    --exclude '*.tfstate' \
    --exclude '*.tfstate.*' \
    "$MORPHO_INFRA_DIR/projects/commons/" "$TMP_DIR/morpho-infra/projects/commons/"
fi

if [[ "$INCLUDE_MORPHO_INFRA_PROJECTS" == "1" && -d "$MORPHO_INFRA_DIR/projects" ]]; then
  rsync -a \
    --exclude '.git' \
    --exclude '.terraform' \
    --exclude '.terragrunt-cache' \
    --exclude '*.tfstate' \
    --exclude '*.tfstate.*' \
    --exclude '*.csv' \
    "$MORPHO_INFRA_DIR/projects/" "$TMP_DIR/morpho-infra/projects/"
fi

rsync -a --delete \
  --exclude '.git' \
  --exclude '.terraform' \
  --exclude '.terragrunt-cache' \
  "$MORPHO_INFRA_HELM_DIR/" "$TMP_DIR/morpho-infra-helm/"

SKILL_BUNDLE_DIR="$TMP_DIR/skills-bundle"
SKILL_BUNDLE_SKILLS_DIR="$SKILL_BUNDLE_DIR/skills"
SKILL_BUNDLE_TAR="$TMP_DIR/skills-bundle.tar.gz"
mkdir -p "$SKILL_BUNDLE_SKILLS_DIR"

echo "      Build curated skill bundle"
for skill_src in \
  "$MORPHO_INFRA_DIR/.codex/skills/incident-troubleshooting" \
  "$MORPHO_INFRA_DIR/.codex/skills/grafana-metrics-best-practices" \
  "$MORPHO_INFRA_DIR/.codex/skills/aws-troubleshooting" \
  "$MORPHO_INFRA_DIR/.codex/skills/aws-terraform" \
  "$MORPHO_INFRA_DIR/.codex/skills/vault-operations" \
  "$MORPHO_INFRA_HELM_DIR/.codex/skills/helm-chart-writer" \
  "$MORPHO_INFRA_HELM_DIR/.codex/skills/kubernetes-security-hardening" \
  "$MORPHO_INFRA_HELM_DIR/.codex/skills/vault-secrets-patterns" \
  "$MORPHO_INFRA_HELM_DIR/.codex/skills/cnpg-database-writer" \
  "$MORPHO_INFRA_HELM_DIR/.codex/skills/request-ci-review" \
  "$HOME/.codex/skills/eks-troubleshoot" \
  "$HOME/.codex/skills/argocd-diff" \
  "$HOME/.codex/skills/go-memory-profiling" \
  "$HOME/.codex/skills/terraform-ci-review"; do
  copy_skill_dir "$skill_src"
done
tar -czf "$SKILL_BUNDLE_TAR" -C "$SKILL_BUNDLE_DIR" skills

echo "[2/8] Ensure ECR repo $ECR_REPO in $AWS_REGION"
if ! aws ecr describe-repositories --region "$AWS_REGION" --repository-names "$ECR_REPO" >/dev/null 2>&1; then
  aws ecr create-repository --region "$AWS_REGION" --repository-name "$ECR_REPO" >/dev/null
fi

if [[ "$OPENCLAW_INSTALL_SOURCE" == "local" ]]; then
  OPENCLAW_BUILD_LABEL="openclaw@local"
else
  OPENCLAW_BUILD_LABEL="openclaw@$OPENCLAW_VERSION"
fi
echo "[3/8] Build and push $IMAGE_URI ($IMAGE_PLATFORM, $OPENCLAW_BUILD_LABEL)"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker build --platform "$IMAGE_PLATFORM" --build-arg "OPENCLAW_VERSION=$OPENCLAW_VERSION" -t "$IMAGE_URI" "$TMP_DIR"
docker push "$IMAGE_URI"

echo "[4/8] Apply config and secrets in $NAMESPACE"
kubectl --context "$CONTEXT" get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl --context "$CONTEXT" create namespace "$NAMESPACE"

BETTERSTACK_INCIDENT_PROMPT="$(cat <<'EOF'
BetterStack incident intake mode:
- Scope: #staging-infra-monitoring (dev), #public-api-monitoring (prod), #platform-monitoring (prod).
- Trigger on BetterStack alert/update messages (including bot-authored messages).
- Always reply in the incident thread under the alert root; never post RCA in channel root.
- For each incident thread provide: incident summary, user impact, evidence (k8s/events/logs/metrics), ranked root-cause hypotheses with confidence, mitigations, validation checks, and next actions.
- When confidence is high and fix is scoped/reversible, run /home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh and include the PR URL in-thread.
- Never reveal secrets or token values.
EOF
)"

RUNTIME_CONFIG="$TMP_DIR/openclaw.runtime.json"
jq \
  --arg slackDmPolicy "$SLACK_DM_POLICY" \
  --arg slackChannelPolicy "$SLACK_CHANNEL_POLICY" \
  --arg slackChannelReplyToMode "$SLACK_CHANNEL_REPLY_TO_MODE" \
  --arg betterstackIncidentPrompt "$BETTERSTACK_INCIDENT_PROMPT" \
  --arg toolsProfile "$TOOLS_PROFILE" \
  --arg sentinelHeartbeatEvery "$SENTINEL_HEARTBEAT_EVERY" \
  --arg sentinelHeartbeatTarget "$SENTINEL_HEARTBEAT_TARGET" \
  --arg sentinelHeartbeatTo "$SENTINEL_HEARTBEAT_TO" \
  --arg sentinelHeartbeatAccountId "$SENTINEL_HEARTBEAT_ACCOUNT_ID" \
  --arg sentinelHeartbeatSession "$SENTINEL_HEARTBEAT_SESSION" \
  --arg sentinelHeartbeatActiveHoursStart "$SENTINEL_HEARTBEAT_ACTIVE_HOURS_START" \
  --arg sentinelHeartbeatActiveHoursEnd "$SENTINEL_HEARTBEAT_ACTIVE_HOURS_END" \
  --arg sentinelHeartbeatActiveHoursTimezone "$SENTINEL_HEARTBEAT_ACTIVE_HOURS_TIMEZONE" \
  --arg botModelPrimary "$BOT_MODEL_PRIMARY" \
  --argjson slackAllowFrom "$SLACK_ALLOW_FROM_JSON" \
  --argjson slackChannelIds "$SLACK_CHANNEL_IDS_JSON" \
  --argjson slackBetterstackChannels "$SLACK_BETTERSTACK_CHANNELS_JSON" \
  --argjson botModelFallbacks "$BOT_MODEL_FALLBACKS_JSON" \
  --argjson toolDeny "$TOOLS_DENY_JSON" \
  --argjson execSafeBins "$EXEC_SAFE_BINS_JSON" \
  --argjson execSafeBinProfiles "$EXEC_SAFE_BIN_PROFILES_JSON" \
  --argjson sreAgentIds "$SRE_AGENT_IDS_JSON" \
  --argjson sentinelRouteAllowlist "$SENTINEL_ROUTE_ALLOWLIST_JSON" \
  --argjson sentinelHeartbeatAckMaxChars "$SENTINEL_HEARTBEAT_ACK_MAX_CHARS" \
  --argjson enableSreSubagents "$ENABLE_SRE_SUBAGENTS_JSON" \
  --argjson enableHeartbeat "$ENABLE_HEARTBEAT_JSON" \
  --argjson enableSreSentinelMode "$ENABLE_SRE_SENTINEL_MODE_JSON" '
  def ensure_obj:
    if type == "object" then . else {} end;
  def merge_unique($base; $extra):
    (($base // []) + ($extra // [])) | map(tostring) | unique;
  def is_betterstack_channel($id; $betterstack):
    any($betterstack[]?; . == $id);
  def channel_entry($id; $betterstack; $prompt):
    if is_betterstack_channel($id; $betterstack)
    then {
      enabled: true,
      requireMention: false,
      allowBots: true,
      skills: ["morpho-sre"],
      systemPrompt: $prompt
    }
    else { enabled: true, requireMention: false, allowBots: false }
    end;
  def channel_map($ids; $betterstack; $prompt):
    reduce $ids[] as $id ({}; .[$id] = channel_entry($id; $betterstack; $prompt));
  def has_agent($id):
    any((.agents.list // [])[]?; .id == $id);
  def ensure_agent($agent):
    if has_agent($agent.id) then . else .agents.list = ((.agents.list // []) + [$agent]) end;
  .
  | del(.commands.ownerDisplay)
  | .gateway = (.gateway | ensure_obj)
  | .gateway.controlUi = ((.gateway.controlUi | ensure_obj) + { dangerouslyAllowHostHeaderOriginFallback: true })
  | .web = ((.web // {}) | .enabled = false)
  | .channels = {
      defaults: (.channels.defaults // {}),
      slack: (.channels.slack // {})
    }
  | .channels.slack.mode = "socket"
  | .channels.slack.dm = ((.channels.slack.dm // {}) + { enabled: true, groupEnabled: true, groupChannels: ["*"] })
  | .channels.slack.dmPolicy = "open"
  | .channels.slack.allowFrom = ["*"]
  | .channels.slack.groupPolicy = "open"
  | .channels.slack.requireMention = false
  | .channels.slack.channels = (
      if ($slackChannelIds | length) > 0
      then channel_map($slackChannelIds; $slackBetterstackChannels; $betterstackIncidentPrompt)
      else {}
      end
    )
  | .channels.slack.replyToModeByChatType = (
      (.channels.slack.replyToModeByChatType // {})
      + { channel: $slackChannelReplyToMode }
    )
  | .channels.slack.streaming = "progress"
  | .channels.slack.nativeStreaming = true
  | .logging = ((.logging // {}) | .redactSensitive = "tools")
  | .tools = (.tools | ensure_obj)
  | .tools.profile = $toolsProfile
  | .tools.deny = merge_unique(.tools.deny; $toolDeny)
  | .tools.loopDetection = ((.tools.loopDetection // {}) + { enabled: true })
  | .tools.exec = (.tools.exec | ensure_obj)
  | .tools.exec.security = "allowlist"
  | .tools.exec.ask = "off"
  | .tools.exec.safeBins = $execSafeBins
  | .tools.exec.safeBinProfiles = ((.tools.exec.safeBinProfiles // {}) + $execSafeBinProfiles)
  | .tools.exec.safeBinTrustedDirs = []
  | .tools.agentToAgent = (.tools.agentToAgent | ensure_obj)
  | .tools.agentToAgent.enabled = $enableSreSubagents
  | .tools.agentToAgent.allow = (
      if $enableSreSubagents
      then merge_unique(.tools.agentToAgent.allow; $sreAgentIds)
      else (.tools.agentToAgent.allow // [])
      end
    )
  | .agents = (.agents | ensure_obj)
  | .agents.defaults = (.agents.defaults | ensure_obj)
  | .agents.defaults.model = (
      (.agents.defaults.model // {})
      + {
          primary: $botModelPrimary,
          fallbacks: merge_unique(.agents.defaults.model.fallbacks; $botModelFallbacks)
        }
    )
  | .agents.defaults.memorySearch = (
      (.agents.defaults.memorySearch // {})
      + {
        enabled: true,
        sources: ["memory", "sessions"],
        extraPaths: merge_unique(
          .agents.defaults.memorySearch.extraPaths;
          ["/Users/florian/morpho/morpho-infra", "/Users/florian/morpho/morpho-infra-helm"]
        )
      }
    )
  | .agents.defaults.subagents = (
      (.agents.defaults.subagents // {})
      + { maxConcurrent: 4, maxSpawnDepth: 2, maxChildrenPerAgent: 5 }
    )
  | if $enableHeartbeat
    then
      .agents.defaults.heartbeat = (
        (.agents.defaults.heartbeat // {})
        + (
          if $enableSreSentinelMode
          then
            {
              every: $sentinelHeartbeatEvery,
              target: $sentinelHeartbeatTarget,
              activeHours: {
                start: $sentinelHeartbeatActiveHoursStart,
                end: $sentinelHeartbeatActiveHoursEnd,
                timezone: $sentinelHeartbeatActiveHoursTimezone
              },
              ackMaxChars: $sentinelHeartbeatAckMaxChars
            }
            + (if ($sentinelHeartbeatSession | length) > 0 then { session: $sentinelHeartbeatSession } else {} end)
            + (if ($sentinelHeartbeatTo | length) > 0 then { to: $sentinelHeartbeatTo } else {} end)
            + (if ($sentinelHeartbeatAccountId | length) > 0 then { accountId: $sentinelHeartbeatAccountId } else {} end)
            + (if ($sentinelRouteAllowlist | length) > 0 then { routeAllowlist: $sentinelRouteAllowlist } else {} end)
          else
            { every: "30m", target: "last" }
          end
        )
      )
    else .
    end
  | if $enableSreSubagents and (has_agent("main") | not)
    then .agents.list = ([{ id: "main", default: true, subagents: { allowAgents: $sreAgentIds } }] + (.agents.list // []))
    else .
    end
  | if $enableSreSubagents
    then
      ensure_agent({
        id: "sre-k8s",
        name: "SRE K8s",
        skills: ["morpho-sre", "eks-troubleshoot", "argocd-diff"],
        tools: { profile: "coding", deny: ["gateway", "nodes"] }
      })
      | ensure_agent({
          id: "sre-observability",
          name: "SRE Observability",
          skills: ["morpho-sre", "go-memory-profiling", "grafana-metrics-best-practices"],
          tools: { profile: "coding", deny: ["gateway", "nodes"] }
        })
      | ensure_agent({
          id: "sre-release",
          name: "SRE Release",
          skills: ["morpho-sre", "terraform-ci-review"],
          tools: { profile: "coding", deny: ["gateway", "nodes"] }
        })
      | .agents.list = (
          (.agents.list // [])
          | map(
              if .id == "main" then
                .subagents = ((.subagents // {}) | .allowAgents = merge_unique(.allowAgents; $sreAgentIds))
              else .
              end
            )
        )
    else .
    end
' "$OPENCLAW_JSON" >"$RUNTIME_CONFIG"

kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic openclaw-sre-config \
  --from-file=openclaw.json="$RUNTIME_CONFIG" \
  --dry-run=client \
  -o yaml | kubectl --context "$CONTEXT" apply -f -

# Keep large skill bundle updates under API annotation limits.
kubectl --context "$CONTEXT" -n "$NAMESPACE" annotate configmap openclaw-sre-skill \
  kubectl.kubernetes.io/last-applied-configuration- >/dev/null 2>&1 || true

kubectl --context "$CONTEXT" -n "$NAMESPACE" create configmap openclaw-sre-skill \
  --from-file=SKILL.md="$SKILL_DIR/SKILL.md" \
  --from-file=HEARTBEAT.md="$SKILL_DIR/HEARTBEAT.md" \
  --from-file=repo-map.md="$SKILL_DIR/references/repo-map.md" \
  --from-file=image-repo-map.sh="$SKILL_DIR/scripts/image-repo-map.sh" \
  --from-file=grafana-api.sh="$SKILL_DIR/scripts/grafana-api.sh" \
  --from-file=betterstack-api.sh="$SKILL_DIR/scripts/betterstack-api.sh" \
  --from-file=repo-clone.sh="$SKILL_DIR/scripts/repo-clone.sh" \
  --from-file=github-ci-status.sh="$SKILL_DIR/scripts/github-ci-status.sh" \
  --from-file=autofix-pr.sh="$SKILL_DIR/scripts/autofix-pr.sh" \
  --from-file=sentinel-triage.sh="$SKILL_DIR/scripts/sentinel-triage.sh" \
  --from-file=prometheus-trends.sh="$SKILL_DIR/scripts/prometheus-trends.sh" \
  --from-file=argocd-sync-status.sh="$SKILL_DIR/scripts/argocd-sync-status.sh" \
  --from-file=cert-secret-health.sh="$SKILL_DIR/scripts/cert-secret-health.sh" \
  --from-file=aws-resource-signals.sh="$SKILL_DIR/scripts/aws-resource-signals.sh" \
  --from-file=aws-cost-report.sh="$SKILL_DIR/scripts/aws-cost-report.sh" \
  --from-file=self-improve-pr.sh="$SKILL_DIR/scripts/self-improve-pr.sh" \
  --from-file=sentinel-snapshot.sh="$SKILL_DIR/scripts/sentinel-snapshot.sh" \
  --from-file=lib-incident-id.sh="$SKILL_DIR/scripts/lib-incident-id.sh" \
  --from-file=lib-state-file.sh="$SKILL_DIR/scripts/lib-state-file.sh" \
  --from-file=lib-continuity-matcher.sh="$SKILL_DIR/scripts/lib-continuity-matcher.sh" \
  --from-file=lib-outbox.sh="$SKILL_DIR/scripts/lib-outbox.sh" \
  --from-file=lib-linear-preflight.sh="$SKILL_DIR/scripts/lib-linear-preflight.sh" \
  --from-file=lib-linear-ticket.sh="$SKILL_DIR/scripts/lib-linear-ticket.sh" \
  --from-file=lib-rca-prompt.sh="$SKILL_DIR/scripts/lib-rca-prompt.sh" \
  --from-file=lib-rca-llm.sh="$SKILL_DIR/scripts/lib-rca-llm.sh" \
  --from-file=lib-rca-crossreview.sh="$SKILL_DIR/scripts/lib-rca-crossreview.sh" \
  --from-file=lib-rca-safety.sh="$SKILL_DIR/scripts/lib-rca-safety.sh" \
  --from-file=lib-thread-archival.sh="$SKILL_DIR/scripts/lib-thread-archival.sh" \
  --from-file=lib-meta-alerts.sh="$SKILL_DIR/scripts/lib-meta-alerts.sh" \
  --from-file=linear-memory-lookup.sh="$SKILL_DIR/scripts/linear-memory-lookup.sh" \
  --from-file=lib-service-graph.sh="$SKILL_DIR/scripts/lib-service-graph.sh" \
  --from-file=relationship-knowledge-build.sh="$SKILL_DIR/scripts/relationship-knowledge-build.sh" \
  --from-file=lib-service-overlay.sh="$SKILL_DIR/scripts/lib-service-overlay.sh" \
  --from-file=lib-incident-memory.sh="$SKILL_DIR/scripts/lib-incident-memory.sh" \
  --from-file=lib-service-context.sh="$SKILL_DIR/scripts/lib-service-context.sh" \
  --from-file=lib-rca-chain.sh="$SKILL_DIR/scripts/lib-rca-chain.sh" \
  --from-file=lib-rca-sink.sh="$SKILL_DIR/scripts/lib-rca-sink.sh" \
  --from-file=lib-overlay-suggestions.sh="$SKILL_DIR/scripts/lib-overlay-suggestions.sh" \
  --from-file=rca_hypothesis_ids.v1.json="$SKILL_DIR/rca_hypothesis_ids.v1.json" \
  --from-file=skills-bundle.tar.gz="$SKILL_BUNDLE_TAR" \
  --from-file=safety.md="$SKILL_DIR/references/safety.md" \
  --dry-run=client \
  -o yaml | kubectl --context "$CONTEXT" apply --server-side --force-conflicts -f -

kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret carapulse-secrets >/dev/null 2>&1 || {
  echo "Missing required secret: $NAMESPACE/carapulse-secrets" >&2
  exit 1
}

require_secret_keys carapulse-secrets vault-addr github-app-id github-app-private-key

carapulse_secret_json="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret carapulse-secrets -o json)"
carapulse_secret_value() {
  local key="$1"
  printf '%s' "$carapulse_secret_json" | jq -r --arg k "$key" '.data[$k] // empty | @base64d' | tr -d '\r'
}

escape_multiline_value() {
  printf '%s' "$1" | jq -Rrs 'gsub("\r";"") | gsub("\n"; "\\n")'
}

CARAPULSE_VAULT_ADDR="$(trim_trailing_eol "$(carapulse_secret_value vault-addr)")"
CARAPULSE_VAULT_TOKEN="$(carapulse_secret_value vault-token | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
ARGOCD_BASE_URL_VALUE="$(trim_trailing_eol "$(carapulse_secret_value argocd-base-url)")"
ARGOCD_TOKEN_VALUE="$(trim_trailing_eol "$(carapulse_secret_value argocd-token)")"
GITHUB_APP_ID_VALUE="$(trim_trailing_eol "$(carapulse_secret_value github-app-id)")"
GITHUB_APP_INSTALLATION_ID_VALUE="$(trim_trailing_eol "$(carapulse_secret_value github-app-installation-id)")"
GITHUB_APP_PRIVATE_KEY_VALUE="$(escape_multiline_value "$(trim_trailing_eol "$(carapulse_secret_value github-app-private-key)")")"
CODEX_AUTH_JSON_RAW_VALUE="$(trim_trailing_eol "$(carapulse_secret_value codex-auth-json)")"
if [[ -n "$CODEX_AUTH_JSON_RAW_VALUE" ]] && printf '%s' "$CODEX_AUTH_JSON_RAW_VALUE" | jq -e . >/dev/null 2>&1; then
  CODEX_AUTH_JSON_VALUE="$(printf '%s' "$CODEX_AUTH_JSON_RAW_VALUE" | jq -c .)"
else
  CODEX_AUTH_JSON_VALUE="$(escape_multiline_value "$CODEX_AUTH_JSON_RAW_VALUE")"
fi
OPENAI_API_KEY_VALUE="$(trim_trailing_eol "$(carapulse_secret_value openai-api-key)")"
OPENAI_ACCESS_TOKEN_VALUE="$(trim_trailing_eol "$(carapulse_secret_value openai-access-token)")"
OPENAI_AUTH_BOOTSTRAP_TOKEN_VALUE="$(trim_trailing_eol "$(carapulse_secret_value openai-auth-bootstrap-token)")"
OPENAI_MODEL_VALUE="$(trim_trailing_eol "$(carapulse_secret_value openai-model)")"
OPENAI_REASONING_EFFORT_VALUE="$(trim_trailing_eol "$(carapulse_secret_value openai-reasoning-effort)")"
ANTHROPIC_API_KEY_VALUE="$(trim_trailing_eol "$(carapulse_secret_value anthropic-api-key)")"

VAULT_ADDR="${VAULT_ADDR:-$CARAPULSE_VAULT_ADDR}"
VAULT_TOKEN="${VAULT_TOKEN:-$CARAPULSE_VAULT_TOKEN}"
if [[ -z "$VAULT_TOKEN" && -f "$HOME/.vault-token" ]]; then
  VAULT_TOKEN="$(tr -d '\r' < "$HOME/.vault-token" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
fi
if [[ -z "$VAULT_ADDR" || -z "$VAULT_TOKEN" ]]; then
  echo "VAULT_ADDR/VAULT_TOKEN missing (set env, ~/.vault-token, or carapulse-secrets vault-addr/vault-token)" >&2
  exit 1
fi

for var_name in \
  SLACK_BOT_TOKEN \
  SLACK_APP_TOKEN \
  GATEWAY_TOKEN \
  GRAFANA_BASE_URL \
  GRAFANA_ALLOWED_HOST \
  GRAFANA_TOKEN \
  BETTERSTACK_API_TOKEN \
  BETTERSTACK_API_BASE \
  BETTERSTACK_ALLOWED_HOST \
  BETTERSTACK_TEAM_ID \
  BETTERSTACK_TEAM_NAME \
  PROMETHEUS_URL \
  SCOPE_NAMESPACES \
  INCIDENT_STATE_DIR \
  COST_REPORT_TARGET \
  RCA_MODE \
  EXEC_ALLOWLIST \
  GITHUB_REQUIRED_REPO \
  GITHUB_REQUIRED_ACTIONS_REPO \
  GITHUB_AUTH_STRICT \
  SENTINEL_ROUTE_TARGET_CRITICAL \
  SENTINEL_ROUTE_TARGET_HIGH \
  SENTINEL_ROUTE_TARGET_MEDIUM \
  SENTINEL_ROUTE_TARGET_LOW \
  SENTINEL_ALERT_COOLDOWN_SECONDS \
  SENTINEL_ALERT_MIN_INTERVAL_SECONDS \
  RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS \
  SRE_AUTO_PR_ENABLED \
  SRE_AUTO_PR_MIN_CONFIDENCE \
  SRE_AUTO_PR_ALLOWED_REPOS \
  SRE_AUTO_PR_BRANCH_PREFIX \
  SRE_AUTO_PR_NOTIFY_ENABLED \
  SRE_AUTO_PR_NOTIFY_USER_ID \
  SRE_AUTO_PR_NOTIFY_STRICT \
  VAULT_ADDR \
  VAULT_TOKEN \
  ARGOCD_BASE_URL_VALUE \
  ARGOCD_TOKEN_VALUE \
  GITHUB_APP_ID_VALUE \
  GITHUB_APP_INSTALLATION_ID_VALUE \
  GITHUB_APP_PRIVATE_KEY_VALUE \
  CODEX_AUTH_JSON_VALUE \
  OPENAI_API_KEY_VALUE \
  OPENAI_ACCESS_TOKEN_VALUE \
  OPENAI_AUTH_BOOTSTRAP_TOKEN_VALUE \
  OPENAI_MODEL_VALUE \
  OPENAI_REASONING_EFFORT_VALUE \
  ANTHROPIC_API_KEY_VALUE; do
  trim_var_in_place "$var_name"
done

vault_payload_file="$TMP_DIR/openclaw-sre-vault-secrets.json"
jq -n \
  --arg SLACK_BOT_TOKEN "$SLACK_BOT_TOKEN" \
  --arg SLACK_APP_TOKEN "$SLACK_APP_TOKEN" \
  --arg OPENCLAW_GATEWAY_TOKEN "$GATEWAY_TOKEN" \
  --arg GRAFANA_BASE_URL "$GRAFANA_BASE_URL" \
  --arg GRAFANA_ALLOWED_HOST "$GRAFANA_ALLOWED_HOST" \
  --arg GRAFANA_TOKEN "$GRAFANA_TOKEN" \
  --arg BETTERSTACK_API_TOKEN "$BETTERSTACK_API_TOKEN" \
  --arg BETTERSTACK_API_BASE "$BETTERSTACK_API_BASE" \
  --arg BETTERSTACK_ALLOWED_HOST "$BETTERSTACK_ALLOWED_HOST" \
  --arg BETTERSTACK_TEAM_ID "$BETTERSTACK_TEAM_ID" \
  --arg BETTERSTACK_TEAM_NAME "$BETTERSTACK_TEAM_NAME" \
  --arg PROMETHEUS_URL "$PROMETHEUS_URL" \
  --arg SCOPE_NAMESPACES "$SCOPE_NAMESPACES" \
  --arg INCIDENT_STATE_DIR "$INCIDENT_STATE_DIR" \
  --arg COST_REPORT_TARGET "$COST_REPORT_TARGET" \
  --arg RCA_MODE "$RCA_MODE" \
  --arg EXEC_ALLOWLIST "$EXEC_ALLOWLIST" \
  --arg GITHUB_REQUIRED_REPO "$GITHUB_REQUIRED_REPO" \
  --arg GITHUB_REQUIRED_ACTIONS_REPO "$GITHUB_REQUIRED_ACTIONS_REPO" \
  --arg GITHUB_AUTH_STRICT "$GITHUB_AUTH_STRICT" \
  --arg ROUTE_TARGET_CRITICAL "$SENTINEL_ROUTE_TARGET_CRITICAL" \
  --arg ROUTE_TARGET_HIGH "$SENTINEL_ROUTE_TARGET_HIGH" \
  --arg ROUTE_TARGET_MEDIUM "$SENTINEL_ROUTE_TARGET_MEDIUM" \
  --arg ROUTE_TARGET_LOW "$SENTINEL_ROUTE_TARGET_LOW" \
  --arg ALERT_COOLDOWN_SECONDS "$SENTINEL_ALERT_COOLDOWN_SECONDS" \
  --arg ALERT_MIN_INTERVAL_SECONDS "$SENTINEL_ALERT_MIN_INTERVAL_SECONDS" \
  --arg RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS "$RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS" \
  --arg AUTO_PR_ENABLED "$SRE_AUTO_PR_ENABLED" \
  --arg AUTO_PR_MIN_CONFIDENCE "$SRE_AUTO_PR_MIN_CONFIDENCE" \
  --arg AUTO_PR_ALLOWED_REPOS "$SRE_AUTO_PR_ALLOWED_REPOS" \
  --arg AUTO_PR_BRANCH_PREFIX "$SRE_AUTO_PR_BRANCH_PREFIX" \
  --arg AUTO_PR_NOTIFY_ENABLED "$SRE_AUTO_PR_NOTIFY_ENABLED" \
  --arg AUTO_PR_NOTIFY_USER_ID "$SRE_AUTO_PR_NOTIFY_USER_ID" \
  --arg AUTO_PR_NOTIFY_STRICT "$SRE_AUTO_PR_NOTIFY_STRICT" \
  --arg VAULT_ADDR "$VAULT_ADDR" \
  --arg VAULT_TOKEN "$VAULT_TOKEN" \
  --arg ARGOCD_BASE_URL "$ARGOCD_BASE_URL_VALUE" \
  --arg ARGOCD_TOKEN "$ARGOCD_TOKEN_VALUE" \
  --arg ARGOCD_AUTH_TOKEN "$ARGOCD_TOKEN_VALUE" \
  --arg GITHUB_APP_ID "$GITHUB_APP_ID_VALUE" \
  --arg GITHUB_APP_INSTALLATION_ID "$GITHUB_APP_INSTALLATION_ID_VALUE" \
  --arg GITHUB_APP_PRIVATE_KEY "$GITHUB_APP_PRIVATE_KEY_VALUE" \
  --arg CODEX_AUTH_JSON "$CODEX_AUTH_JSON_VALUE" \
  --arg OPENAI_API_KEY "$OPENAI_API_KEY_VALUE" \
  --arg OPENAI_ACCESS_TOKEN "$OPENAI_ACCESS_TOKEN_VALUE" \
  --arg OPENAI_AUTH_BOOTSTRAP_TOKEN "$OPENAI_AUTH_BOOTSTRAP_TOKEN_VALUE" \
  --arg OPENAI_MODEL "$OPENAI_MODEL_VALUE" \
  --arg OPENAI_REASONING_EFFORT "$OPENAI_REASONING_EFFORT_VALUE" \
  --arg ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY_VALUE" \
  '{
    data: {
      SLACK_BOT_TOKEN: $SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: $SLACK_APP_TOKEN,
      OPENCLAW_GATEWAY_TOKEN: $OPENCLAW_GATEWAY_TOKEN,
      GRAFANA_BASE_URL: $GRAFANA_BASE_URL,
      GRAFANA_ALLOWED_HOST: $GRAFANA_ALLOWED_HOST,
      GRAFANA_TOKEN: $GRAFANA_TOKEN,
      BETTERSTACK_API_TOKEN: $BETTERSTACK_API_TOKEN,
      BETTERSTACK_API_BASE: $BETTERSTACK_API_BASE,
      BETTERSTACK_ALLOWED_HOST: $BETTERSTACK_ALLOWED_HOST,
      BETTERSTACK_TEAM_ID: $BETTERSTACK_TEAM_ID,
      BETTERSTACK_TEAM_NAME: $BETTERSTACK_TEAM_NAME,
      PROMETHEUS_URL: $PROMETHEUS_URL,
      SCOPE_NAMESPACES: $SCOPE_NAMESPACES,
      INCIDENT_STATE_DIR: $INCIDENT_STATE_DIR,
      COST_REPORT_TARGET: $COST_REPORT_TARGET,
      RCA_MODE: $RCA_MODE,
      EXEC_ALLOWLIST: $EXEC_ALLOWLIST,
      GITHUB_REQUIRED_REPO: $GITHUB_REQUIRED_REPO,
      GITHUB_REQUIRED_ACTIONS_REPO: $GITHUB_REQUIRED_ACTIONS_REPO,
      GITHUB_AUTH_STRICT: $GITHUB_AUTH_STRICT,
      ROUTE_TARGET_CRITICAL: $ROUTE_TARGET_CRITICAL,
      ROUTE_TARGET_HIGH: $ROUTE_TARGET_HIGH,
      ROUTE_TARGET_MEDIUM: $ROUTE_TARGET_MEDIUM,
      ROUTE_TARGET_LOW: $ROUTE_TARGET_LOW,
      ALERT_COOLDOWN_SECONDS: $ALERT_COOLDOWN_SECONDS,
      ALERT_MIN_INTERVAL_SECONDS: $ALERT_MIN_INTERVAL_SECONDS,
      RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS: $RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS,
      AUTO_PR_ENABLED: $AUTO_PR_ENABLED,
      AUTO_PR_MIN_CONFIDENCE: $AUTO_PR_MIN_CONFIDENCE,
      AUTO_PR_ALLOWED_REPOS: $AUTO_PR_ALLOWED_REPOS,
      AUTO_PR_BRANCH_PREFIX: $AUTO_PR_BRANCH_PREFIX,
      AUTO_PR_NOTIFY_ENABLED: $AUTO_PR_NOTIFY_ENABLED,
      AUTO_PR_NOTIFY_USER_ID: $AUTO_PR_NOTIFY_USER_ID,
      AUTO_PR_NOTIFY_STRICT: $AUTO_PR_NOTIFY_STRICT,
      VAULT_ADDR: $VAULT_ADDR,
      VAULT_TOKEN: $VAULT_TOKEN,
      ARGOCD_BASE_URL: $ARGOCD_BASE_URL,
      ARGOCD_TOKEN: $ARGOCD_TOKEN,
      ARGOCD_AUTH_TOKEN: $ARGOCD_AUTH_TOKEN,
      GITHUB_APP_ID: $GITHUB_APP_ID,
      GITHUB_APP_INSTALLATION_ID: $GITHUB_APP_INSTALLATION_ID,
      GITHUB_APP_PRIVATE_KEY: $GITHUB_APP_PRIVATE_KEY,
      CODEX_AUTH_JSON: $CODEX_AUTH_JSON,
      OPENAI_API_KEY: $OPENAI_API_KEY,
      OPENAI_ACCESS_TOKEN: $OPENAI_ACCESS_TOKEN,
      OPENAI_AUTH_BOOTSTRAP_TOKEN: $OPENAI_AUTH_BOOTSTRAP_TOKEN,
      OPENAI_MODEL: $OPENAI_MODEL,
      OPENAI_REASONING_EFFORT: $OPENAI_REASONING_EFFORT,
      ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
    }
  }' >"$vault_payload_file"

echo "[4.5/8] Sync bot secrets to Vault ($VAULT_SECRETS_PATH)"
VAULT_ADDR="$VAULT_ADDR" VAULT_TOKEN="$VAULT_TOKEN" vault write "$VAULT_SECRETS_PATH" @"$vault_payload_file" >/dev/null

if [[ "$INJECT_AWS_CREDS" == "1" ]]; then
  AWS_EXPORT_FILE="$TMP_DIR/aws.env"
  if aws configure export-credentials --format env >"$AWS_EXPORT_FILE" 2>/dev/null; then
    set -a
    # shellcheck disable=SC1090
    source "$AWS_EXPORT_FILE"
    set +a

    if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
      aws_secret_cmd=(
        kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic openclaw-sre-aws
        "--from-literal=AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}"
        "--from-literal=AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}"
      )

      if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
        aws_secret_cmd+=("--from-literal=AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN}")
      fi
      if [[ -n "${AWS_CREDENTIAL_EXPIRATION:-}" ]]; then
        aws_secret_cmd+=("--from-literal=AWS_CREDENTIAL_EXPIRATION=${AWS_CREDENTIAL_EXPIRATION}")
      fi

      "${aws_secret_cmd[@]}" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
    fi
  fi
fi

adopt_helm_resource() {
  local kind="$1"
  local name="$2"
  if kubectl --context "$CONTEXT" -n "$NAMESPACE" get "$kind/$name" >/dev/null 2>&1; then
    kubectl --context "$CONTEXT" -n "$NAMESPACE" annotate --overwrite "$kind/$name" \
      meta.helm.sh/release-name="$HELM_RELEASE" \
      meta.helm.sh/release-namespace="$NAMESPACE" >/dev/null
    kubectl --context "$CONTEXT" -n "$NAMESPACE" label --overwrite "$kind/$name" \
      app.kubernetes.io/managed-by=Helm >/dev/null
  fi
}

if [[ "$SERVICE_ACCOUNT_CREATE" == "true" || "$SERVICE_ACCOUNT_CREATE" == "1" ]]; then
  echo "[5/8] Ensure service account $SERVICE_ACCOUNT_NAME"
  if [[ -n "$INCIDENT_READONLY_ROLE_ARN" ]]; then
    cat <<EOF | kubectl --context "$CONTEXT" -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${SERVICE_ACCOUNT_NAME}
  namespace: ${NAMESPACE}
  annotations:
    eks.amazonaws.com/role-arn: ${INCIDENT_READONLY_ROLE_ARN}
EOF
    applied_sa_role="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get sa "$SERVICE_ACCOUNT_NAME" -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}')"
    if [[ "$applied_sa_role" != "$INCIDENT_READONLY_ROLE_ARN" ]]; then
      echo "ServiceAccount IRSA annotation mismatch: expected ${INCIDENT_READONLY_ROLE_ARN}, got ${applied_sa_role:-<empty>}" >&2
      exit 1
    fi
  else
    cat <<EOF | kubectl --context "$CONTEXT" -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${SERVICE_ACCOUNT_NAME}
  namespace: ${NAMESPACE}
EOF
  fi
fi

echo "[5/8] Ensure vault secret RBAC"
cat <<EOF | kubectl --context "$CONTEXT" -n "$NAMESPACE" apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${HELM_RELEASE}-vault-secret
  namespace: ${NAMESPACE}
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "get", "list", "patch", "update", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${HELM_RELEASE}-vault-secret
  namespace: ${NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${HELM_RELEASE}-vault-secret
subjects:
  - kind: ServiceAccount
    name: ${SERVICE_ACCOUNT_NAME}
    namespace: ${NAMESPACE}
EOF

echo "[5/8] Helm upgrade/install $HELM_RELEASE"
adopt_helm_resource deployment openclaw-sre
adopt_helm_resource service openclaw-sre
adopt_helm_resource pvc openclaw-sre-state
adopt_helm_resource configmap openclaw-sre-skill
adopt_helm_resource serviceaccount "$SERVICE_ACCOUNT_NAME"
adopt_helm_resource role "${HELM_RELEASE}-vault-secret"
adopt_helm_resource rolebinding "${HELM_RELEASE}-vault-secret"
HELM_SCOPE_NAMESPACES_ESCAPED="${SCOPE_NAMESPACES//,/\\,}"
helm --kube-context "$CONTEXT" upgrade --install "$HELM_RELEASE" "$HELM_CHART_DIR" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --take-ownership \
  --force-conflicts \
  --set-string image.uri="$IMAGE_URI" \
  --set replicaCount="$DEPLOY_REPLICAS" \
  --set-string serviceAccountName="$SERVICE_ACCOUNT_NAME" \
  --set serviceAccount.create="$SERVICE_ACCOUNT_CREATE" \
  --set-string serviceAccount.roleArn="$INCIDENT_READONLY_ROLE_ARN" \
  --set-string vault.secretsPath="$VAULT_SECRETS_PATH" \
  --set-string vault.secretName="$VAULT_K8S_SECRET_NAME" \
  --set-string vault.roleName="$SERVICE_ACCOUNT_NAME" \
  --set-string prometheus.url="$PROMETHEUS_URL" \
  --set-string signals.scopeNamespaces="$HELM_SCOPE_NAMESPACES_ESCAPED" \
  --set-string incidentState.dir="$INCIDENT_STATE_DIR" \
  --set-string rca.mode="$RCA_MODE" \
  --set-string rca.serviceContextEnabled="$SERVICE_CONTEXT_ENABLED" \
  --set-string rca.chainEnabled="$RCA_CHAIN_ENABLED" \
  --set-string rca.chainStageEEnabled="$RCA_CHAIN_STAGE_E_ENABLED" \
  --set-string rca.incidentLearningEnabled="$INCIDENT_LEARNING_ENABLED" \
  --set-string rca.chainTotalTimeoutMs="$RCA_CHAIN_TOTAL_TIMEOUT_MS" \
  --set-string rca.stageTimeoutMs="$RCA_STAGE_TIMEOUT_MS" \
  --set-string rca.evidenceTotalTimeoutMs="$RCA_EVIDENCE_TOTAL_TIMEOUT_MS" \
  --set-string rca.minRerunIntervalSeconds="$RCA_MIN_RERUN_INTERVAL_S" \
  --set-string rca.chainCostAlertThreshold="$RCA_CHAIN_COST_ALERT_THRESHOLD" \
  --set-string rca.chainDualMaxReviewRounds="$RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS" \
  --set-string costCron.target="$COST_REPORT_TARGET" \
  --set selfImproveCron.enabled="$SELF_IMPROVE_CRON_ENABLED" \
  --set-string selfImproveCron.schedule="$SELF_IMPROVE_CRON_SCHEDULE" \
  --set-string selfImproveCron.repo="$SELF_IMPROVE_REPO" \
  --set-string selfImproveCron.baseBranch="$SELF_IMPROVE_BASE_BRANCH" \
  --set-string selfImproveCron.lookbackHours="$SELF_IMPROVE_LOOKBACK_HOURS" \
  --set-string selfImproveCron.confidence="$SELF_IMPROVE_CONFIDENCE" \
  --set-string selfImproveCron.branchPrefix="$SELF_IMPROVE_BRANCH_PREFIX"

echo "[6/8] Rollout status"
kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret "$VAULT_K8S_SECRET_NAME" >/dev/null
kubectl --context "$CONTEXT" -n "$NAMESPACE" rollout status deployment/openclaw-sre --timeout=300s
kubectl --context "$CONTEXT" -n "$NAMESPACE" get pods -l app=openclaw-sre -o wide

POD_NAME="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get pods -l app=openclaw-sre --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "$POD_NAME" ]]; then
  echo "No running pod found for app=openclaw-sre" >&2
  exit 1
fi

echo "[7/8] Runtime checks from pod $POD_NAME"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "kubectl get nodes >/tmp/openclaw_nodes.txt && sed -n '1,5p' /tmp/openclaw_nodes.txt"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "kubectl -n monitoring get svc -o jsonpath='{range .items[*]}{.metadata.name}{\"\\n\"}{end}' >/tmp/openclaw_svcs.txt && sed -n '1,15p' /tmp/openclaw_svcs.txt"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "curl --max-time 5 -sSI http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090/-/ready | sed -n '1p'"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "test -f /tmp/github-preflight.ok && echo github-preflight:ok"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "test -f /home/node/.openclaw/workspace/HEARTBEAT.md && echo heartbeat-playbook:ok"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "jq -c '.agents.defaults.heartbeat // {}' /home/node/.openclaw/openclaw.json"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "set -e; tmp=\$(mktemp); /home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh >\"\$tmp\"; sed -n '1,60p' \"\$tmp\"; rm -f \"\$tmp\""
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "set -e; tmp=\$(mktemp); /home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh >\"\$tmp\"; sed -n '1,40p' \"\$tmp\"; rm -f \"\$tmp\""
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "set -e; tmp=\$(mktemp); /home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --repo morpho-org/morpho-infra >\"\$tmp\"; sed -n '1,5p' \"\$tmp\"; rm -f \"\$tmp\""
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "set -e; tmp=\$(mktemp); /home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --repo morpho-org/morpho-infra --limit 1 >\"\$tmp\"; sed -n '1,5p' \"\$tmp\"; rm -f \"\$tmp\""
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "set -e; /home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents?per_page=1' >/dev/null; echo betterstack-api:ok"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh --help | sed -n '1,12p'"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "/home/node/.openclaw/skills/morpho-sre/scripts/self-improve-pr.sh --help | sed -n '1,16p'"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "arn=\$(aws sts get-caller-identity --query Arn --output text); echo \"\$arn\"; echo \"\$arn\" | grep -q '${INCIDENT_READONLY_ROLE_ARN##*/}'"
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
  "out=\$(openclaw health 2>&1); rc=\$?; echo \"\$out\" | sed -n '1,80p'; exit \$rc"

echo "Deployed image: $IMAGE_URI"
echo "Service URL (in-cluster): http://openclaw-sre.${NAMESPACE}.svc.cluster.local:18789"
echo "[8/8] Done"
