#!/usr/bin/env bash
# Copy this repo's config/ to the VM. Run from repo root.
# Loads deployment.env; requires OPENCLAW_ON_VM_PATH and GCP_VM_*.
#
# Usage: ./scripts/copy-config-to-vm.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ ! -f "$REPO_ROOT/deployment.env" ]]; then
  echo "Missing deployment.env. Copy deployment.example.env to deployment.env and set OPENCLAW_ON_VM_PATH and GCP_VM_*." >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
source "$REPO_ROOT/deployment.env"
set +a

: "${OPENCLAW_ON_VM_PATH:?Set OPENCLAW_ON_VM_PATH in deployment.env}"
: "${GCP_VM_PROJECT:?Set GCP_VM_PROJECT in deployment.env}"
: "${GCP_VM_NAME:?Set GCP_VM_NAME in deployment.env}"
: "${GCP_VM_ZONE:?Set GCP_VM_ZONE in deployment.env}"

echo "Copying config/ to $GCP_VM_NAME:$OPENCLAW_ON_VM_PATH/config/"
gcloud compute ssh "$GCP_VM_NAME" \
  --project="$GCP_VM_PROJECT" \
  --zone="$GCP_VM_ZONE" \
  -- "mkdir -p $OPENCLAW_ON_VM_PATH/config"
gcloud compute scp --recurse \
  --project="$GCP_VM_PROJECT" \
  --zone="$GCP_VM_ZONE" \
  "$REPO_ROOT/config" \
  "$GCP_VM_NAME:$OPENCLAW_ON_VM_PATH/"

echo "Done. Config is at $OPENCLAW_ON_VM_PATH/config/ on the VM."
