#!/usr/bin/env bash
#
# Uninstall OpenClaw from Google Compute Engine
#
# Usage:
#   ./scripts/deploy/google/compute-engine/uninstall.sh [OPTIONS]
#
# Options:
#   --project PROJECT_ID    Google Cloud project ID (required)
#   --zone ZONE             Compute Engine zone (default: us-central1-a)
#   --instance NAME         Instance name (default: openclaw-gateway)
#   --keep-firewall         Don't delete firewall rule
#   --help                  Show this help message
#
# Examples:
#   # Delete everything
#   ./scripts/deploy/google/compute-engine/uninstall.sh --project my-project
#
#   # Keep firewall rule for future deployments
#   ./scripts/deploy/google/compute-engine/uninstall.sh --project my-project --keep-firewall
#
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values (matching run.sh defaults)
ZONE="us-central1-a"
INSTANCE_NAME="openclaw-gateway"
PROJECT_ID=""
KEEP_FIREWALL=false

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }
log_detail() { echo -e "    ${NC}↳ $1"; }

show_help() {
  head -22 "$0" | tail -20 | sed 's/^#//' | sed 's/^ //'
  exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --zone) ZONE="$2"; shift 2 ;;
    --instance) INSTANCE_NAME="$2"; shift 2 ;;
    --keep-firewall) KEEP_FIREWALL=true; shift ;;
    --help|-h) show_help ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate required arguments
if [[ -z "$PROJECT_ID" ]]; then
  log_error "Project ID is required. Use --project PROJECT_ID"
  echo ""
  echo "Usage: $0 --project YOUR_PROJECT_ID [OPTIONS]"
  exit 1
fi

# Check prerequisites
check_prerequisites() {
  log_step "Checking prerequisites"

  log_info "Checking if gcloud CLI is installed..."
  if ! command -v gcloud &> /dev/null; then
    log_error "gcloud CLI is not installed!"
    log_detail "Install from: https://cloud.google.com/sdk/docs/install"
    exit 1
  fi
  log_detail "gcloud CLI found: $(which gcloud)"

  log_info "Checking gcloud authentication..."
  if ! gcloud auth print-access-token &> /dev/null; then
    log_error "Not authenticated with gcloud!"
    log_detail "Run: gcloud auth login"
    exit 1
  fi
  log_detail "Authenticated as: $(gcloud config get-value account 2>/dev/null)"

  log_success "Prerequisites OK"
}

# Delete Compute Engine instance
delete_instance() {
  log_step "Deleting Compute Engine instance"

  log_info "Checking if instance exists..."
  if gcloud compute instances describe "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" &>/dev/null; then
    log_detail "Instance found: $INSTANCE_NAME"
    log_info "Deleting instance..."
    if gcloud compute instances delete "$INSTANCE_NAME" \
      --project="$PROJECT_ID" \
      --zone="$ZONE" \
      --quiet; then
      log_success "Instance deleted: $INSTANCE_NAME"
    else
      log_error "Failed to delete instance"
      exit 1
    fi
  else
    log_warn "Instance not found: $INSTANCE_NAME (already deleted?)"
  fi
}

# Delete firewall rule
delete_firewall() {
  if [[ "$KEEP_FIREWALL" == "true" ]]; then
    log_step "Keeping firewall rule (--keep-firewall flag)"
    log_info "Firewall rule will be preserved for future deployments"
    return
  fi

  log_step "Deleting firewall rule"

  log_info "Checking firewall rule..."
  if gcloud compute firewall-rules describe openclaw-gateway --project="$PROJECT_ID" &>/dev/null; then
    log_detail "Firewall rule found, deleting..."
    if gcloud compute firewall-rules delete openclaw-gateway \
      --project="$PROJECT_ID" \
      --quiet 2>/dev/null; then
      log_success "Firewall rule deleted"
    else
      log_warn "Failed to delete firewall rule"
    fi
  else
    log_detail "Firewall rule not found (skipping)"
  fi
}

# Main
main() {
  echo ""
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║   OpenClaw Compute Engine Uninstaller                       ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Configuration:"
  echo "  Project:        $PROJECT_ID"
  echo "  Zone:           $ZONE"
  echo "  Instance:       $INSTANCE_NAME"
  echo "  Keep firewall:  $KEEP_FIREWALL"
  echo ""

  check_prerequisites
  delete_instance
  delete_firewall

  echo ""
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║     Uninstall Complete                                     ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  echo ""
  log_success "OpenClaw has been removed from Compute Engine"
  echo ""

  if [[ "$KEEP_FIREWALL" == "true" ]]; then
    echo "Note: Firewall rule was preserved. To delete it later:"
    echo "  gcloud compute firewall-rules delete openclaw-gateway --project=$PROJECT_ID"
    echo ""
  fi

  echo "To redeploy:"
  echo "  ./scripts/deploy/google/compute-engine/run.sh --project $PROJECT_ID --anthropic-key YOUR_KEY"
  echo ""
}

main
