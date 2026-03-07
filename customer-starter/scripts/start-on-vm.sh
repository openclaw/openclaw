#!/usr/bin/env bash
# Start (or restart) this customer's OpenClaw container on the VM.
# Run from repo root. Loads deployment.env.
#
# The VM must have the main OpenClaw repo at OPENCLAW_REPO_ON_VM_PATH with
# .env set (including the instance config dir pointing at this customer's config).
#
# Usage: ./scripts/start-on-vm.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ ! -f "$REPO_ROOT/deployment.env" ]]; then
  echo "Missing deployment.env. Copy deployment.example.env to deployment.env and set OPENCLAW_REPO_ON_VM_PATH, OPENCLAW_CONTAINER_NAME, GCP_VM_*." >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
source "$REPO_ROOT/deployment.env"
set +a

: "${OPENCLAW_REPO_ON_VM_PATH:?Set OPENCLAW_REPO_ON_VM_PATH in deployment.env}"
: "${OPENCLAW_CONTAINER_NAME:?Set OPENCLAW_CONTAINER_NAME in deployment.env}"
: "${GCP_VM_PROJECT:?Set GCP_VM_PROJECT in deployment.env}"
: "${GCP_VM_NAME:?Set GCP_VM_NAME in deployment.env}"
: "${GCP_VM_ZONE:?Set GCP_VM_ZONE in deployment.env}"

"$REPO_ROOT/scripts/vm-ssh.sh" -- "cd $OPENCLAW_REPO_ON_VM_PATH && docker compose -f platforms/gcp-vm/docker-compose.multi.yml --env-file .env up -d $OPENCLAW_CONTAINER_NAME"
echo "Started (or restarted) $OPENCLAW_CONTAINER_NAME. Check: ./scripts/vm-ssh.sh -- 'docker ps'"
