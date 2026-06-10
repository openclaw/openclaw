#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
# Treat unset variables as an error during substitution.
# Fail pipelines if any intermediate stage drops a non-zero status code.
set -euo pipefail

# --- 🎨 Sovereign Theme Colors & Formatting ---
SAFFRON='\033[38;5;208m'
BOLD='\033[1m'
DIM='\033[2m'
ERROR='\033[0;31m'
NC='\033[0m' # No Color

log() {
    echo -e "${DIM}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ${BOLD}$1${NC}"
}

log_section() {
    echo -e "\n${SAFFRON}${BOLD}=== $1 ===${NC}"
    log "Intent: $2"
}

log_error() {
    echo -e "${ERROR}${BOLD}[ERROR] $1${NC}" >&2
}

# --- ⚙️ Argument Parsing Loop ───────────────────────────────
TARGET_NODE=""
REGISTRY=${REGISTRY:-"registry.guardianhub.com:30000"}
IMAGE_NAME="yantram/openclaw"
NO_CACHE=${NO_CACHE:-false}
CLI_NAMESPACE=""

# Standard parameter evaluation block
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      TARGET_NODE="$2"
      shift 2
      ;;
    --no-cache)
      NO_CACHE=true
      shift
      ;;
    -n|--namespace)
      CLI_NAMESPACE="$2"
      shift 2
      ;;
    *)
      log_error "Unrecognized flag parameters: $1"
      echo "Usage: $0 --target [guardianhub|spark] [--no-cache] [-n namespace]"
      exit 1
      ;;
  esac
done

if [ -z "$TARGET_NODE" ]; then
    log "⚠️ No explicit target node passed. Defaulting to local [guardianhub] profile..."
    TARGET_NODE="guardianhub"
fi

# --- 🏗️ Context Resolution ──────────────────────────────────
case "$TARGET_NODE" in
    guardianhub)
        BUILD_PLATFORM="linux/amd64"
        IMAGE_TAG="latest-guardianhub"
        NAMESPACE="yantram-gate"
        ;;
    spark)
        BUILD_PLATFORM="linux/arm64"
        IMAGE_TAG="latest-spark"
        NAMESPACE="yantram-gate"
        ;;
    *)
        log_error "Unsupported target environment option profile: $TARGET_NODE"
        echo "Available options: --target guardianhub | --target spark"
        exit 1
        ;;
esac # 🎯 FIX 1: Added missing block closing statement

# Apply runtime overrides if passed via command line options
NAMESPACE="${CLI_NAMESPACE:-$NAMESPACE}"
FULL_IMAGE_NAME="$REGISTRY/$IMAGE_NAME:$IMAGE_TAG"
DEPLOYMENT_NAME="openclaw"

# Locate project base cleanly relative to script location
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# --- 🔄 1. Upstream Git Sync Loop ---
log_section "GIT SYNCHRONIZATION" "Ensuring your fork workspace tree is pristine and synchronized"

# --- 🔄 1. Upstream Git Sync (Disabled for Stability) ---
log_section "GIT STATUS CHECK" "Verifying workspace integrity"

if [ -n "$(git status --porcelain)" ]; then
    log "⚠️ Uncommitted changes detected in workspace."
    log "ℹ️ Proceeding with current local state. Ensure you have merged manually if required."
else
    log "✅ Workspace clean. Proceeding with build."
fi

# --- 🐳 2. Colima JIT Lifecycle Management ---
log_section "INFRASTRUCTURE VIRTUALIZATION" "Waking up Colima engine and mapping sovereign domain routing tables"
if ! colima status >/dev/null 2>&1; then
    log "Colima runtime is sleeping. Igniting engine with optimized footprints..."
    # 🎯 Footprint verification matches your requested 12GB allocation setting limits
    colima start --vm-type qemu --cpu 4 --memory 12 --dns 8.8.8.8
else
    log "Colima engine runtime heartbeat verified active."
fi

log "Syncing local cluster platform hosts parameters..."
GUARDIANHUB_IP="${GUARDIANHUB_IP:-192.168.29.27}"

colima ssh << EOF
sudo sed -i '/registry.guardianhub.com/d' /etc/hosts
echo "${GUARDIANHUB_IP} registry.guardianhub.com" | sudo tee -a /etc/hosts > /dev/null
EOF

# --- 🎯 3. Dynamic Node CPU Architecture Discovery ---
log_section "ARCHITECTURAL MATRIX RESOLUTION" "Probing Kubernetes cluster plane nodes for native processor styles"

NODE_ARCH=$(kubectl get node guardianhub -o jsonpath='{.status.nodeInfo.architecture}' 2>/dev/null || echo "arm64")
TARGET_PLATFORM="$BUILD_PLATFORM" # 🎯 FIX 2: Added evaluation operator symbol

UPPER_ARCH=$(echo "$NODE_ARCH" | tr '[:lower:]' '[:upper:]')
log "🎯 Target node requires architecture signature: $UPPER_ARCH"

# --- 🏗️ 4. Build Engine Trigger Execution ---
log_section "CONTAINER COMPILATION" "Assembling multi-stage image metrics for platform target: $TARGET_PLATFORM"

CACHE_FLAG=""
if [ "$NO_CACHE" = true ]; then
    CACHE_FLAG="--no-cache"
fi

DOCKERFILE_TARGET="Dockerfile"
if [ ! -f "$DOCKERFILE_TARGET" ] && [ -f "Dockerfile.dev" ]; then
    DOCKERFILE_TARGET="Dockerfile.dev"
fi
log "Using target schema blueprint: $DOCKERFILE_TARGET"

export DOCKER_BUILDKIT=1
# 🎯 THE CRITICAL UPGRADE: Switch to buildx build and output back to local docker daemon
if ! docker buildx build \
    $CACHE_FLAG \
    --platform "$TARGET_PLATFORM" \
    --build-arg OPENCLAW_VARIANT="runtime" \
    --progress=plain \
    --output type=docker \
    -t "$FULL_IMAGE_NAME" \
    -f "$DOCKERFILE_TARGET" \
    . 2>&1 | tee /tmp/openclaw_build.log; then

    log_error "Docker build pipeline experienced a terminal failure context."
    tail -n 50 /tmp/openclaw_build.log
    exit 1
fi

# --- 🚀 5. Registry Upload Pipeline ---
log_section "REGISTRY INJECTION" "Pushing compiled manifest tree layers up to cluster workspace"
if ! docker push "$FULL_IMAGE_NAME"; then
    log_error "Failed to push image to target storage endpoint: $REGISTRY"
    exit 1
fi
log "Image layers successfully integrated into core network distribution tables."

# --- 💤 6. Early Virtual Machine Resource Teardown ---
log_section "INFRASTRUCTURE TEARDOWN" "Suspending Colima environment to lower host laptop thermal values"
colima stop
log "Colima engine successfully suspended. Core thread allocation freed."

# --- ☸️ 7. Live Kubernetes Rollout Orchestration ---
log_section "KUBERNETES DEPLOYMENT ROLLOUT" "Signaling master plane controllers to recycle pods in [$NAMESPACE]"

log "Triggering hot rollout restart tracking strings for deployment: $DEPLOYMENT_NAME"
kubectl rollout restart deployment/"$DEPLOYMENT_NAME" -n "$NAMESPACE"

log "Awaiting container rotation and cluster sync confirmation checks..."
if ! kubectl rollout status deployment/"$DEPLOYMENT_NAME" --timeout=2m -n "$NAMESPACE"; then
    log_error "Deployment lifecycle failed status updates or exceeded execution limits."
    kubectl describe deployment "$DEPLOYMENT_NAME" -n "$NAMESPACE"
    kubectl logs -l app="$DEPLOYMENT_NAME" --tail=50 -n "$NAMESPACE"
    exit 1
fi

log_section "PIPELINE SUCCESSFUL" "OpenClaw image layers successfully built, distributed, and hot-swapped!"