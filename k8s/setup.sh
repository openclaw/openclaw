#!/usr/bin/env bash
# ============================================================================
# OpenClaw Kubernetes Setup Script
# ============================================================================
#
# Deploys OpenClaw Gateway to a vanilla Kubernetes cluster.
#
# Usage:
#   ./k8s/setup.sh                     # Interactive setup
#   ./k8s/setup.sh --env-file .env     # Reuse existing .env
#   ./k8s/setup.sh --delete            # Tear down the deployment
#
# Prerequisites:
#   - kubectl connected to a cluster
#   - envsubst (gettext)
#
# After deployment:
#   kubectl port-forward svc/openclaw 18789:18789 -n <namespace>
#   open http://localhost:18789
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFESTS_DIR="$SCRIPT_DIR/manifests"
ENV_FILE=""
DELETE=false
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}"

# ---------------------------------------------------------------------------
# Colors / logging
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()    { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && fail "--env-file requires a path"
      ENV_FILE="$2"; shift 2 ;;
    --delete)
      DELETE=true; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--env-file PATH] [--delete] [-h|--help]"
      exit 0 ;;
    *)
      fail "Unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
info "Checking prerequisites..."

if ! command -v kubectl &>/dev/null; then
  fail "kubectl is not installed. Install it from https://kubernetes.io/docs/tasks/tools/"
fi

if ! kubectl cluster-info &>/dev/null; then
  fail "Cannot connect to Kubernetes cluster. Check your kubeconfig."
fi

if ! command -v envsubst &>/dev/null; then
  fail "envsubst is not installed. Install gettext (brew install gettext / apt install gettext-base)."
fi

CLUSTER_SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || echo "unknown")
CLUSTER_USER=$(kubectl config view --minify -o jsonpath='{.contexts[0].context.user}' 2>/dev/null || echo "unknown")
success "Connected to $CLUSTER_SERVER as $CLUSTER_USER"

# ---------------------------------------------------------------------------
# Delete mode
# ---------------------------------------------------------------------------
if $DELETE; then
  if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
  elif [[ -f "$SCRIPT_DIR/.env" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
  fi
  NS="${OPENCLAW_NAMESPACE:-}"
  if [[ -z "$NS" ]]; then
    read -rp "Namespace to delete: " NS
  fi
  if [[ -z "$NS" ]]; then
    fail "No namespace specified."
  fi
  warn "This will delete namespace '$NS' and all resources in it."
  read -rp "Type the namespace name to confirm: " CONFIRM
  if [[ "$CONFIRM" != "$NS" ]]; then
    fail "Confirmation did not match. Aborting."
  fi
  kubectl delete namespace "$NS" --ignore-not-found
  success "Namespace '$NS' deleted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Load or prompt for configuration
# ---------------------------------------------------------------------------
if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  info "Loading config from $ENV_FILE"
  # shellcheck disable=SC1090
  source "$ENV_FILE"
elif [[ -f "$SCRIPT_DIR/.env" ]]; then
  info "Found existing k8s/.env"
  read -rp "Reuse existing configuration? [Y/n]: " REUSE
  if [[ "${REUSE:-Y}" =~ ^[Yy]$ ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
  fi
fi

# Prompt for any missing values
if [[ -z "${OPENCLAW_NAMESPACE:-}" ]]; then
  echo ""
  echo -e "${BOLD}Namespace${NC}"
  read -rp "Namespace name [openclaw]: " OPENCLAW_NAMESPACE
  OPENCLAW_NAMESPACE="${OPENCLAW_NAMESPACE:-openclaw}"
fi

if [[ -z "${AGENT_DISPLAY_NAME:-}" ]]; then
  read -rp "Agent display name [OpenClaw Assistant]: " AGENT_DISPLAY_NAME
  AGENT_DISPLAY_NAME="${AGENT_DISPLAY_NAME:-OpenClaw Assistant}"
fi

# ---------------------------------------------------------------------------
# Model provider selection
# ---------------------------------------------------------------------------
# Initialize all provider keys (may be populated from .env.k8s)
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
MISTRAL_API_KEY="${MISTRAL_API_KEY:-}"
XAI_API_KEY="${XAI_API_KEY:-}"
GROQ_API_KEY="${GROQ_API_KEY:-}"

# Check if any key is already set (from .env.k8s or environment)
has_any_key() {
  [[ -n "$ANTHROPIC_API_KEY" || -n "$OPENAI_API_KEY" || -n "$GEMINI_API_KEY" \
    || -n "$OPENROUTER_API_KEY" || -n "$MISTRAL_API_KEY" || -n "$XAI_API_KEY" \
    || -n "$GROQ_API_KEY" ]]
}

if ! has_any_key; then
  echo ""
  echo -e "${BOLD}Model Provider${NC}"
  echo ""
  echo "  OpenClaw auto-discovers models from provider API keys."
  echo "  Set at least one. You can add more later via the Gateway UI."
  echo ""
  echo "  1) Anthropic      (Claude)"
  echo "  2) OpenAI         (GPT, Codex)"
  echo "  3) Google Gemini"
  echo "  4) OpenRouter     (access many providers via one key)"
  echo "  5) Mistral"
  echo "  6) xAI            (Grok)"
  echo "  7) Groq"
  echo "  8) Skip           (configure later)"
  echo ""
  read -rp "Choose a provider [1-8]: " PROVIDER_CHOICE

  case "${PROVIDER_CHOICE:-8}" in
    1)
      read -rsp "Anthropic API key: " ANTHROPIC_API_KEY; echo "" ;;
    2)
      read -rsp "OpenAI API key: " OPENAI_API_KEY; echo "" ;;
    3)
      read -rsp "Gemini API key: " GEMINI_API_KEY; echo "" ;;
    4)
      read -rsp "OpenRouter API key: " OPENROUTER_API_KEY; echo "" ;;
    5)
      read -rsp "Mistral API key: " MISTRAL_API_KEY; echo "" ;;
    6)
      read -rsp "xAI API key: " XAI_API_KEY; echo "" ;;
    7)
      read -rsp "Groq API key: " GROQ_API_KEY; echo "" ;;
    8)
      info "Skipping provider setup. Configure via the Gateway UI after deployment." ;;
    *)
      warn "Invalid choice. Skipping provider setup." ;;
  esac
fi

# Generate gateway token if not set
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  OPENCLAW_GATEWAY_TOKEN=$(openssl rand -base64 32)
  success "Generated gateway token"
fi

# Determine default model from the first available key
if [[ -z "${DEFAULT_AGENT_MODEL:-}" ]]; then
  if [[ -n "$ANTHROPIC_API_KEY" ]]; then
    DEFAULT_AGENT_MODEL="anthropic/claude-sonnet-4-6"
  elif [[ -n "$OPENAI_API_KEY" ]]; then
    DEFAULT_AGENT_MODEL="openai/gpt-4.1-mini"
  elif [[ -n "$GEMINI_API_KEY" ]]; then
    DEFAULT_AGENT_MODEL="google/gemini-2.5-flash"
  elif [[ -n "$OPENROUTER_API_KEY" ]]; then
    DEFAULT_AGENT_MODEL="openrouter/anthropic/claude-sonnet-4-6"
  elif [[ -n "$MISTRAL_API_KEY" ]]; then
    DEFAULT_AGENT_MODEL="mistral/mistral-large-latest"
  elif [[ -n "$XAI_API_KEY" ]]; then
    DEFAULT_AGENT_MODEL="xai/grok-3"
  elif [[ -n "$GROQ_API_KEY" ]]; then
    DEFAULT_AGENT_MODEL="groq/llama-3.3-70b-versatile"
  else
    DEFAULT_AGENT_MODEL=""
    warn "No API key provided. You will need to configure a model provider via the Gateway UI."
  fi
fi

if [[ -n "$DEFAULT_AGENT_MODEL" ]]; then
  success "Default model: $DEFAULT_AGENT_MODEL"
fi

# Export for envsubst
export OPENCLAW_NAMESPACE AGENT_DISPLAY_NAME OPENCLAW_GATEWAY_TOKEN
export DEFAULT_AGENT_MODEL OPENCLAW_IMAGE
export ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY
export OPENROUTER_API_KEY MISTRAL_API_KEY XAI_API_KEY GROQ_API_KEY

# ---------------------------------------------------------------------------
# Save .env.k8s (git-ignored)
# ---------------------------------------------------------------------------
cat > "$SCRIPT_DIR/.env" <<ENVEOF
# Generated by k8s/setup.sh — do not commit
OPENCLAW_NAMESPACE="${OPENCLAW_NAMESPACE}"
AGENT_DISPLAY_NAME="${AGENT_DISPLAY_NAME}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN}"
DEFAULT_AGENT_MODEL="${DEFAULT_AGENT_MODEL}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"
OPENAI_API_KEY="${OPENAI_API_KEY}"
GEMINI_API_KEY="${GEMINI_API_KEY}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
MISTRAL_API_KEY="${MISTRAL_API_KEY}"
XAI_API_KEY="${XAI_API_KEY}"
GROQ_API_KEY="${GROQ_API_KEY}"
ENVEOF
chmod 600 "$SCRIPT_DIR/.env"
success "Saved configuration to k8s/.env"

# ---------------------------------------------------------------------------
# Generate manifests into k8s/manifests/generated/
# ---------------------------------------------------------------------------
GENERATED_DIR="$MANIFESTS_DIR/generated"
rm -rf "$GENERATED_DIR"
mkdir -p "$GENERATED_DIR"

info "Generating manifests..."

ENVSUBST_VARS='${OPENCLAW_NAMESPACE} ${AGENT_DISPLAY_NAME} ${OPENCLAW_GATEWAY_TOKEN} ${DEFAULT_AGENT_MODEL} ${OPENCLAW_IMAGE} ${ANTHROPIC_API_KEY} ${OPENAI_API_KEY} ${GEMINI_API_KEY} ${OPENROUTER_API_KEY} ${MISTRAL_API_KEY} ${XAI_API_KEY} ${GROQ_API_KEY}'

for src in "$MANIFESTS_DIR"/*; do
  [[ -f "$src" ]] || continue
  base="$(basename "$src")"
  if [[ "$base" == *.envsubst ]]; then
    # Render template
    out="$GENERATED_DIR/${base%.envsubst}"
    envsubst "$ENVSUBST_VARS" < "$src" > "$out"
    success "Rendered $base → $(basename "$out")"
  else
    # Copy static manifest
    cp "$src" "$GENERATED_DIR/$base"
  fi
done

# ---------------------------------------------------------------------------
# Kind: load image if using a local kind cluster
# ---------------------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -q . && [[ "$OPENCLAW_IMAGE" == *":local"* ]]; then
  info "Detected Kind cluster — loading local image..."
  kind load docker-image "$OPENCLAW_IMAGE" 2>/dev/null || warn "Could not load image into Kind. Continuing anyway."
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
echo ""
info "Deploying to namespace '$OPENCLAW_NAMESPACE'..."

# Create namespace if it doesn't exist
kubectl create namespace "$OPENCLAW_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
success "Namespace '$OPENCLAW_NAMESPACE' ready"

# Apply kustomize
kubectl apply -k "$GENERATED_DIR" 2>&1 | while read -r line; do
  echo -e "  ${GREEN}+${NC} $line"
done

# Update deployment image (in case OPENCLAW_IMAGE differs from manifest default)
kubectl set image deployment/openclaw gateway="$OPENCLAW_IMAGE" -n "$OPENCLAW_NAMESPACE" >/dev/null 2>&1 || true

# Restart pod to pick up any Secret/ConfigMap changes
kubectl rollout restart deployment/openclaw -n "$OPENCLAW_NAMESPACE" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Wait for rollout
# ---------------------------------------------------------------------------
echo ""
info "Waiting for deployment to be ready (up to 5 minutes)..."
if kubectl rollout status deployment/openclaw -n "$OPENCLAW_NAMESPACE" --timeout=300s; then
  success "OpenClaw is running!"
else
  warn "Deployment not ready yet. Check: kubectl get pods -n $OPENCLAW_NAMESPACE"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==============================================================="
echo -e " ${GREEN}${BOLD}OpenClaw deployed to Kubernetes${NC}"
echo "==============================================================="
echo ""
echo "  Namespace:  $OPENCLAW_NAMESPACE"
echo "  Image:      $OPENCLAW_IMAGE"
echo ""
echo -e "  ${BOLD}Access the gateway:${NC}"
echo ""
echo "    kubectl port-forward svc/openclaw 18789:18789 -n $OPENCLAW_NAMESPACE"
echo "    open http://localhost:18789"
echo ""
echo -e "  ${BOLD}Gateway token:${NC}"
echo "    $OPENCLAW_GATEWAY_TOKEN"
echo ""
echo "  Paste the token into Settings in the Control UI."
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo "    kubectl get pods -n $OPENCLAW_NAMESPACE"
echo "    kubectl logs -f deployment/openclaw -n $OPENCLAW_NAMESPACE"
echo "    curl -fsS http://localhost:18789/healthz  (while port-forward is active)"
echo ""
