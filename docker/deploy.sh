#!/usr/bin/env bash
# docker/deploy.sh
# Roll out a new piboonsak/openclaw image on the Hostinger VPS.
#
# Usage (from local machine):
#   SSH_KEY=~/.ssh/id_ed25519_hostinger \
#   VPS_HOST=srv1414058.hstgr.cloud \
#   VPS_USER=root \
#     bash docker/deploy.sh [IMAGE_TAG]
#
# Called by:
#   .github/workflows/deploy-vps.yml   (automated, after image push)
#   manual operator invocation
#
# Environment variables:
#   VPS_HOST      VPS hostname or IP  (default: srv1414058.hstgr.cloud)
#   VPS_USER      SSH user            (default: root)
#   SSH_KEY       Path to SSH private key (default: ~/.ssh/id_ed25519_hostinger)
#   IMAGE_TAG     Docker image tag    (default: latest)
#   APP_DIR       App dir on VPS      (default: /opt/openclaw)
#
# SECURITY: This script does NOT handle secrets. Secrets live in .env on the VPS.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
VPS_HOST="${VPS_HOST:-srv1414058.hstgr.cloud}"
VPS_USER="${VPS_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_hostinger}"
IMAGE_TAG="${1:-${IMAGE_TAG:-latest}}"
APP_DIR="${APP_DIR:-/opt/openclaw}"
DOCKER_IMAGE="piboonsak/openclaw:${IMAGE_TAG}"
CONTAINER_NAME="openclaw-sgnl-openclaw-1"

# ── Validation ────────────────────────────────────────────────────────────────
if [[ ! -f "$SSH_KEY" ]]; then
  echo "ERROR: SSH key not found at $SSH_KEY"
  echo "       Set SSH_KEY env var or put key there."
  exit 1
fi

echo "→ Deploying $DOCKER_IMAGE to $VPS_USER@$VPS_HOST"
echo "  App dir:   $APP_DIR"
echo "  Container: $CONTAINER_NAME"
echo ""

# ── SSH helper ────────────────────────────────────────────────────────────────
run_remote() {
  ssh -i "$SSH_KEY" \
      -o StrictHostKeyChecking=no \
      -o ConnectTimeout=30 \
      "${VPS_USER}@${VPS_HOST}" "$@"
}

# ── Deploy steps (executed on the VPS) ───────────────────────────────────────
run_remote bash -s -- "$DOCKER_IMAGE" "$APP_DIR" "$CONTAINER_NAME" << 'REMOTE_EOF'
set -euo pipefail
DOCKER_IMAGE="$1"
APP_DIR="$2"
CONTAINER_NAME="$3"

echo "[1/4] Pulling image: $DOCKER_IMAGE"
docker pull "$DOCKER_IMAGE"

echo "[2/4] Starting/updating container via docker compose"
cd "$APP_DIR"
# --pull always ensures the freshly pulled image is used
docker compose -f docker-compose.prod.yml up -d --pull always

echo "[3/4] Verifying container is running"
RUNNING=$(docker inspect --format='{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo "false")
if [[ "$RUNNING" != "true" ]]; then
  echo "ERROR: Container $CONTAINER_NAME is not running after deploy"
  docker logs "$CONTAINER_NAME" --tail 50
  exit 1
fi
echo "Container $CONTAINER_NAME is running ✔"

echo "[4/4] Health check"
# Wait up to 40 s for the gateway health endpoint to respond
for i in $(seq 1 8); do
  if curl -sf http://localhost:18789/health > /dev/null; then
    echo "Health check passed ✔"
    break
  fi
  if [[ "$i" -eq 8 ]]; then
    echo "WARNING: Health check timed out after 40s (check logs)"
    docker logs "$CONTAINER_NAME" --tail 30
  else
    echo "  ... waiting for health (attempt $i/8)"
    sleep 5
  fi
done

echo ""
echo "Deploy complete: $DOCKER_IMAGE → $CONTAINER_NAME"
docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
REMOTE_EOF

echo ""
echo "✓ Deployment finished."
echo "  Live URL: https://openclaw.yahwan.biz/health"
