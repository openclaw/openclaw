#!/usr/bin/env bash
# ============================================================================
# KIND CLUSTER BOOTSTRAP SCRIPT
# ============================================================================
#
# Usage:
#   ./k8s/create-cluster.sh                     # Create with auto-detected engine
#   ./k8s/create-cluster.sh --provider podman    # Force podman
#   ./k8s/create-cluster.sh --name mycluster     # Custom cluster name
#   ./k8s/create-cluster.sh --delete              # Delete the cluster
#
# After creation, deploy with:
#   ./k8s/setup.sh
# ============================================================================

set -euo pipefail

# Defaults
CLUSTER_NAME="openclaw"
PROVIDER=""
DELETE=false

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()    { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --name NAME          Cluster name (default: openclaw)
  --provider TYPE      Container engine: podman or docker (auto-detected if omitted)
  --delete             Delete the cluster instead of creating it
  -h, --help           Show this help message

Examples:
  $(basename "$0")                          # Create cluster (auto-detect engine)
  $(basename "$0") --provider podman        # Create cluster using podman
  $(basename "$0") --delete                 # Delete the cluster
  $(basename "$0") --name dev --delete      # Delete a cluster named "dev"
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ -z "${2:-}" ]] && fail "--name requires a value"
      CLUSTER_NAME="$2"; shift 2 ;;
    --provider)
      [[ -z "${2:-}" ]] && fail "--provider requires a value"
      PROVIDER="$2"; shift 2 ;;
    --delete)
      DELETE=true; shift ;;
    -h|--help)
      usage ;;
    *)
      fail "Unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Container engine detection
# ---------------------------------------------------------------------------
detect_provider() {
  if command -v podman &>/dev/null; then
    echo "podman"
  elif command -v docker &>/dev/null; then
    echo "docker"
  else
    fail "Neither podman nor docker found. Install one to use Kind."
  fi
}

if [[ -z "$PROVIDER" ]]; then
  PROVIDER=$(detect_provider)
  info "Auto-detected container engine: $PROVIDER"
else
  case "$PROVIDER" in
    podman|docker) ;;
    *) fail "Invalid --provider value '$PROVIDER'. Must be 'podman' or 'docker'." ;;
  esac
  if ! command -v "$PROVIDER" &>/dev/null; then
    fail "$PROVIDER is not installed."
  fi
  info "Using container engine: $PROVIDER"
fi

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v kind &>/dev/null; then
  fail "kind is not installed. Install it from https://kind.sigs.k8s.io/"
fi

# Verify the container engine is responsive
if [[ "$PROVIDER" == "docker" ]]; then
  if ! docker info &>/dev/null; then
    fail "Docker daemon is not running. Start it and try again."
  fi
elif [[ "$PROVIDER" == "podman" ]]; then
  if ! podman info &>/dev/null; then
    fail "Podman is not responding. Ensure the podman machine is running (podman machine start)."
  fi
fi

# ---------------------------------------------------------------------------
# Delete mode
# ---------------------------------------------------------------------------
if $DELETE; then
  info "Deleting Kind cluster '$CLUSTER_NAME'..."
  if KIND_EXPERIMENTAL_PROVIDER="$PROVIDER" kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    KIND_EXPERIMENTAL_PROVIDER="$PROVIDER" kind delete cluster --name "$CLUSTER_NAME"
    success "Cluster '$CLUSTER_NAME' deleted."
  else
    warn "Cluster '$CLUSTER_NAME' does not exist."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Check if cluster already exists
# ---------------------------------------------------------------------------
if KIND_EXPERIMENTAL_PROVIDER="$PROVIDER" kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  warn "Cluster '$CLUSTER_NAME' already exists."
  info "To recreate it, run: $0 --delete && $0"
  info "Switching kubectl context to kind-$CLUSTER_NAME..."
  kubectl cluster-info --context "kind-$CLUSTER_NAME" &>/dev/null && success "Context set." || warn "Could not switch context."
  exit 0
fi

# ---------------------------------------------------------------------------
# Create cluster
# ---------------------------------------------------------------------------
info "Creating Kind cluster '$CLUSTER_NAME' (provider: $PROVIDER)..."

KIND_EXPERIMENTAL_PROVIDER="$PROVIDER" kind create cluster \
  --name "$CLUSTER_NAME" \
  --config - <<'KINDCFG'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  labels:
    openclaw.dev/role: control-plane
KINDCFG

success "Kind cluster '$CLUSTER_NAME' created."

# ---------------------------------------------------------------------------
# Wait for readiness
# ---------------------------------------------------------------------------
info "Waiting for cluster to be ready..."
kubectl --context "kind-$CLUSTER_NAME" wait --for=condition=Ready nodes --all --timeout=120s >/dev/null
success "All nodes are Ready."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "---------------------------------------------------------------"
echo " Kind cluster '$CLUSTER_NAME' is ready"
echo "---------------------------------------------------------------"
echo ""
echo "  kubectl cluster-info --context kind-$CLUSTER_NAME"
echo ""
echo "  Next step — deploy OpenClaw:"
echo ""
echo "    ./k8s/setup.sh"
echo ""
