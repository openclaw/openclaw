#!/usr/bin/env bash
# SSH to the GCP VM. Loads deployment.env from this repo root so you can run
# commands on the VM (e.g. docker ps, manage-multi.sh).
#
# Usage (from repo root):
#   ./scripts/vm-ssh.sh                  # interactive SSH
#   ./scripts/vm-ssh.sh -- 'docker ps'   # run one command
#
# Requires: gcloud, deployment.env (copy from deployment.example.env).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/deployment.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/deployment.env"
  set +a
fi

GCP_VM_PROJECT="${GCP_VM_PROJECT:-gidr-demo}"
GCP_VM_NAME="${GCP_VM_NAME:-openclaw-gateway}"
GCP_VM_ZONE="${GCP_VM_ZONE:-us-central1-a}"

if [[ $# -eq 0 ]]; then
  exec gcloud compute ssh "$GCP_VM_NAME" \
    --project="$GCP_VM_PROJECT" \
    --zone="$GCP_VM_ZONE"
fi

if [[ "$1" == "--" ]]; then
  shift
fi
exec gcloud compute ssh "$GCP_VM_NAME" \
  --project="$GCP_VM_PROJECT" \
  --zone="$GCP_VM_ZONE" \
  -- \
  "$@"
