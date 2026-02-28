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
DEFAULT_SKILL_DIR="$ROOT_DIR/deploy/skills/morpho-sre"
if [[ -d "$DEFAULT_SKILL_DIR" ]]; then
  SKILL_DIR="${SKILL_DIR:-$DEFAULT_SKILL_DIR}"
else
  SKILL_DIR="${SKILL_DIR:-$HOME/.openclaw/skills/morpho-sre}"
fi
MORPHO_INFRA_DIR="${MORPHO_INFRA_DIR:-/Users/florian/morpho/morpho-infra}"
MORPHO_INFRA_HELM_DIR="${MORPHO_INFRA_HELM_DIR:-/Users/florian/morpho/morpho-infra-helm}"
MANIFEST="${MANIFEST:-$ROOT_DIR/deploy/eks/openclaw-sre-dev.yaml}"
RUNTIME_DOCKERFILE="${RUNTIME_DOCKERFILE:-$ROOT_DIR/deploy/eks/Dockerfile.runtime}"
INJECT_AWS_CREDS="${INJECT_AWS_CREDS:-0}"
INCLUDE_MORPHO_INFRA_PROJECTS="${INCLUDE_MORPHO_INFRA_PROJECTS:-0}"
SLACK_ALLOWED_USER_IDS="${SLACK_ALLOWED_USER_IDS:-U07KE3NALTX}"
SLACK_ALLOWED_CHANNEL_IDS="${SLACK_ALLOWED_CHANNEL_IDS:-}"
SLACK_DM_POLICY="${SLACK_DM_POLICY:-allowlist}"
SLACK_CHANNEL_POLICY="${SLACK_CHANNEL_POLICY:-allowlist}"
TOOLS_PROFILE="${TOOLS_PROFILE:-coding}"
TOOLS_DENY="${TOOLS_DENY:-gateway,nodes}"
EXEC_SAFE_BINS="${EXEC_SAFE_BINS:-jq,cut,uniq,head,tail,tr,wc}"
EXEC_ALLOWLIST="${EXEC_ALLOWLIST:-/home/node/.openclaw/skills/morpho-sre/scripts/*.sh,/usr/bin/bash,/usr/bin/sh,/usr/bin/aws,/usr/bin/curl,/usr/bin/git,/usr/bin/gh,/usr/bin/jq,/usr/bin/sed,/usr/bin/awk,/usr/bin/grep,/usr/bin/sort,/usr/bin/cat,/usr/bin/head,/usr/bin/tail,/usr/bin/cut,/usr/bin/uniq,/usr/bin/tr,/usr/bin/wc,/usr/bin/xargs,/usr/bin/timeout,/usr/bin/tar,/usr/bin/unzip,/usr/bin/gzip,/usr/local/bin/kubectl,/usr/local/bin/helm,/usr/local/bin/argocd,/usr/local/bin/vault}"
ENABLE_SRE_SUBAGENTS="${ENABLE_SRE_SUBAGENTS:-1}"
ENABLE_HEARTBEAT="${ENABLE_HEARTBEAT:-1}"
ENABLE_SRE_SENTINEL_MODE="${ENABLE_SRE_SENTINEL_MODE:-1}"
SENTINEL_HEARTBEAT_EVERY="${SENTINEL_HEARTBEAT_EVERY:-5m}"
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
SRE_AGENT_IDS="${SRE_AGENT_IDS:-sre-k8s,sre-observability,sre-release}"
GITHUB_REQUIRED_REPO="${GITHUB_REQUIRED_REPO:-morpho-org/morpho-infra}"
GITHUB_REQUIRED_ACTIONS_REPO="${GITHUB_REQUIRED_ACTIONS_REPO:-$GITHUB_REQUIRED_REPO}"
GITHUB_AUTH_STRICT="${GITHUB_AUTH_STRICT:-1}"

case "$DEPLOY_ENV" in
  dev)
    DEFAULT_GRAFANA_BASE_URL="https://monitoring-dev.morpho.dev"
    DEFAULT_GRAFANA_ALLOWED_HOST="monitoring-dev.morpho.dev"
    GRAFANA_TOKEN_KEYS="token dev_token"
    ;;
  prod)
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

for cmd in aws docker jq kubectl mktemp rsync sed; do
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
  "$SKILL_DIR/scripts/repo-clone.sh" \
  "$SKILL_DIR/scripts/github-ci-status.sh" \
  "$SKILL_DIR/scripts/sentinel-triage.sh" \
  "$SKILL_DIR/scripts/sentinel-snapshot.sh" \
  "$SKILL_DIR/references/safety.md" \
  "$MORPHO_INFRA_DIR" \
  "$MORPHO_INFRA_HELM_DIR" \
  "$MANIFEST" \
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

SLACK_ALLOW_FROM_JSON="$(to_json_array "$SLACK_ALLOWED_USER_IDS")"
SLACK_CHANNEL_IDS_JSON="$(to_json_array "$SLACK_ALLOWED_CHANNEL_IDS")"
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

GATEWAY_TOKEN="$(jq -r '.gateway.auth.token // empty' "$OPENCLAW_JSON")"
if [[ -z "$GATEWAY_TOKEN" || "$GATEWAY_TOKEN" == "null" ]]; then
  echo "gateway.auth.token missing in $OPENCLAW_JSON" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
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

RUNTIME_CONFIG="$TMP_DIR/openclaw.runtime.json"
jq \
  --arg slackDmPolicy "$SLACK_DM_POLICY" \
  --arg slackChannelPolicy "$SLACK_CHANNEL_POLICY" \
  --arg toolsProfile "$TOOLS_PROFILE" \
  --arg sentinelHeartbeatEvery "$SENTINEL_HEARTBEAT_EVERY" \
  --arg sentinelHeartbeatTarget "$SENTINEL_HEARTBEAT_TARGET" \
  --arg sentinelHeartbeatTo "$SENTINEL_HEARTBEAT_TO" \
  --arg sentinelHeartbeatAccountId "$SENTINEL_HEARTBEAT_ACCOUNT_ID" \
  --arg sentinelHeartbeatSession "$SENTINEL_HEARTBEAT_SESSION" \
  --arg sentinelHeartbeatActiveHoursStart "$SENTINEL_HEARTBEAT_ACTIVE_HOURS_START" \
  --arg sentinelHeartbeatActiveHoursEnd "$SENTINEL_HEARTBEAT_ACTIVE_HOURS_END" \
  --arg sentinelHeartbeatActiveHoursTimezone "$SENTINEL_HEARTBEAT_ACTIVE_HOURS_TIMEZONE" \
  --argjson slackAllowFrom "$SLACK_ALLOW_FROM_JSON" \
  --argjson slackChannelIds "$SLACK_CHANNEL_IDS_JSON" \
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
  def channel_map($ids):
    reduce $ids[] as $id ({}; .[$id] = { enabled: true, requireMention: false, allowBots: false });
  def has_agent($id):
    any((.agents.list // [])[]?; .id == $id);
  def ensure_agent($agent):
    if has_agent($agent.id) then . else .agents.list = ((.agents.list // []) + [$agent]) end;
  .
  | del(.commands.ownerDisplay)
  | del(.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback)
  | .web = ((.web // {}) | .enabled = false)
  | .channels = {
      defaults: (.channels.defaults // {}),
      slack: (.channels.slack // {})
    }
  | .channels.slack.mode = "socket"
  | .channels.slack.dm = ((.channels.slack.dm // {}) + { enabled: true, groupEnabled: false })
  | .channels.slack.dmPolicy = $slackDmPolicy
  | .channels.slack.allowFrom = (
      if ($slackAllowFrom | length) > 0
      then $slackAllowFrom
      else (.channels.slack.allowFrom // [])
      end
    )
  | .channels.slack.groupPolicy = (
      if ($slackChannelIds | length) > 0
      then $slackChannelPolicy
      else "disabled"
      end
    )
  | .channels.slack.channels = (
      if ($slackChannelIds | length) > 0
      then channel_map($slackChannelIds)
      else {}
      end
    )
  | .channels.slack.nativeStreaming = false
  | if (.channels.slack.streaming | type) == "string" then .channels.slack.streaming = true else . end
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

kubectl --context "$CONTEXT" -n "$NAMESPACE" create configmap openclaw-sre-skill \
  --from-file=SKILL.md="$SKILL_DIR/SKILL.md" \
  --from-file=HEARTBEAT.md="$SKILL_DIR/HEARTBEAT.md" \
  --from-file=repo-map.md="$SKILL_DIR/references/repo-map.md" \
  --from-file=image-repo-map.sh="$SKILL_DIR/scripts/image-repo-map.sh" \
  --from-file=grafana-api.sh="$SKILL_DIR/scripts/grafana-api.sh" \
  --from-file=repo-clone.sh="$SKILL_DIR/scripts/repo-clone.sh" \
  --from-file=github-ci-status.sh="$SKILL_DIR/scripts/github-ci-status.sh" \
  --from-file=sentinel-triage.sh="$SKILL_DIR/scripts/sentinel-triage.sh" \
  --from-file=sentinel-snapshot.sh="$SKILL_DIR/scripts/sentinel-snapshot.sh" \
  --from-file=skills-bundle.tar.gz="$SKILL_BUNDLE_TAR" \
  --from-file=safety.md="$SKILL_DIR/references/safety.md" \
  --dry-run=client \
  -o yaml | kubectl --context "$CONTEXT" apply -f -

kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic openclaw-sre-env \
  --from-literal=SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" \
  --from-literal=SLACK_APP_TOKEN="$SLACK_APP_TOKEN" \
  --from-literal=OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
  --from-literal=GRAFANA_BASE_URL="$GRAFANA_BASE_URL" \
  --from-literal=GRAFANA_ALLOWED_HOST="$GRAFANA_ALLOWED_HOST" \
  --from-literal=GRAFANA_TOKEN="$GRAFANA_TOKEN" \
  --from-literal=EXEC_ALLOWLIST="$EXEC_ALLOWLIST" \
  --from-literal=GITHUB_REQUIRED_REPO="$GITHUB_REQUIRED_REPO" \
  --from-literal=GITHUB_REQUIRED_ACTIONS_REPO="$GITHUB_REQUIRED_ACTIONS_REPO" \
  --from-literal=GITHUB_AUTH_STRICT="$GITHUB_AUTH_STRICT" \
  --from-literal=ROUTE_TARGET_CRITICAL="$SENTINEL_ROUTE_TARGET_CRITICAL" \
  --from-literal=ROUTE_TARGET_HIGH="$SENTINEL_ROUTE_TARGET_HIGH" \
  --from-literal=ROUTE_TARGET_MEDIUM="$SENTINEL_ROUTE_TARGET_MEDIUM" \
  --from-literal=ROUTE_TARGET_LOW="$SENTINEL_ROUTE_TARGET_LOW" \
  --dry-run=client \
  -o yaml | kubectl --context "$CONTEXT" apply -f -

kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret carapulse-secrets >/dev/null 2>&1 || {
  echo "Missing required secret: $NAMESPACE/carapulse-secrets" >&2
  exit 1
}

require_secret_keys carapulse-secrets github-app-id github-app-private-key

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

echo "[5/8] Apply workload manifest"
sed "s|\${IMAGE_URI}|${IMAGE_URI}|g" "$MANIFEST" | kubectl --context "$CONTEXT" apply -f -

echo "[6/8] Rollout status"
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
  "out=\$(openclaw health 2>&1); rc=\$?; echo \"\$out\" | sed -n '1,80p'; exit \$rc"

echo "Deployed image: $IMAGE_URI"
echo "Service URL (in-cluster): http://openclaw-sre.${NAMESPACE}.svc.cluster.local:18789"
echo "[8/8] Done"
