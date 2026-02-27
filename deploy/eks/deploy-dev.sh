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

for cmd in aws docker jq kubectl mktemp rsync sed; do
  require_cmd "$cmd"
done

for path in \
  "$OPENCLAW_JSON" \
  "$SLACK_ENV_FILE" \
  "$SKILL_DIR/SKILL.md" \
  "$SKILL_DIR/references/repo-map.md" \
  "$SKILL_DIR/scripts/image-repo-map.sh" \
  "$SKILL_DIR/scripts/grafana-api.sh" \
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

echo "[3/8] Build and push $IMAGE_URI ($IMAGE_PLATFORM, openclaw@$OPENCLAW_VERSION)"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker build --platform "$IMAGE_PLATFORM" --build-arg "OPENCLAW_VERSION=$OPENCLAW_VERSION" -t "$IMAGE_URI" "$TMP_DIR"
docker push "$IMAGE_URI"

echo "[4/8] Apply config and secrets in $NAMESPACE"
kubectl --context "$CONTEXT" get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl --context "$CONTEXT" create namespace "$NAMESPACE"

RUNTIME_CONFIG="$TMP_DIR/openclaw.runtime.json"
jq '
  del(.commands.ownerDisplay)
  | del(.channels.slack.nativeStreaming)
  | .channels.slack.mode = "socket"
  | .gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true
  | if (.channels.slack.streaming | type) == "string"
    then .channels.slack.streaming = true
    else .
    end
' "$OPENCLAW_JSON" >"$RUNTIME_CONFIG"

kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic openclaw-sre-config \
  --from-file=openclaw.json="$RUNTIME_CONFIG" \
  --dry-run=client \
  -o yaml | kubectl --context "$CONTEXT" apply -f -

kubectl --context "$CONTEXT" -n "$NAMESPACE" create configmap openclaw-sre-skill \
  --from-file=SKILL.md="$SKILL_DIR/SKILL.md" \
  --from-file=repo-map.md="$SKILL_DIR/references/repo-map.md" \
  --from-file=image-repo-map.sh="$SKILL_DIR/scripts/image-repo-map.sh" \
  --from-file=grafana-api.sh="$SKILL_DIR/scripts/grafana-api.sh" \
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
  --dry-run=client \
  -o yaml | kubectl --context "$CONTEXT" apply -f -

kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret carapulse-secrets >/dev/null 2>&1 || {
  echo "Missing required secret: $NAMESPACE/carapulse-secrets" >&2
  exit 1
}

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
  "out=\$(openclaw health 2>&1); rc=\$?; echo \"\$out\" | sed -n '1,80p'; exit \$rc"

echo "Deployed image: $IMAGE_URI"
echo "Service URL (in-cluster): http://openclaw-sre.${NAMESPACE}.svc.cluster.local:18789"
echo "[8/8] Done"
