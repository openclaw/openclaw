#!/usr/bin/env bash
set -euo pipefail

# ─── OpenClaw Gateway — Deploy to Hetzner ────────────────────────────────────
#
# Usage:
#   ./deploy.sh <tag> [server]
#
# Deploys a tagged image to a Hetzner production server by:
#   1. Checking for port conflicts across all agents
#   2. Pulling the image on the target server
#   3. Updating OPENCLAW_IMAGE in each agent's docker.env
#   4. Rolling out one agent at a time with health checks
#   5. Rolling back on failure
#
# Arguments:
#   tag     - Image tag to deploy (e.g. v2026.04.05.1)
#   server  - SSH host alias: 1stclaw (EU, default), 2ndclaw (US), or "all"
#
# Prerequisites:
#   - SSH config with 1stclaw and 2ndclaw host entries on this machine
#   - Target server has docker + compose installed
#   - Target server can pull from Artifact Registry

REGISTRY="europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway"
AGENTS_DIR="/root/.openclaw/agents"
COMPOSE_DIR="/opt/openclaw"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Rollback depth kept by the pre-pull image prune (see prune-gateway-images.sh).
KEEP_RECENT=2

# ── Args ──────────────────────────────────────────────────────────────────────
if [[ -z "${1:-}" ]]; then
  echo "Usage: deploy.sh <tag> [server|all]" >&2
  echo "  server: 1stclaw (EU), 2ndclaw (US), or 'all' (default)" >&2
  exit 1
fi

TAG="$1"
IMAGE="${REGISTRY}:${TAG}"
TARGET="${2:-all}"

if [[ "$TARGET" == "all" ]]; then
  SERVERS=(1stclaw 2ndclaw)
elif [[ "$TARGET" == "1stclaw" || "$TARGET" == "2ndclaw" ]]; then
  SERVERS=("$TARGET")
else
  echo "ERROR: Unknown server '$TARGET'. Use 1stclaw, 2ndclaw, or all." >&2
  exit 1
fi

# ── Port conflict check (runs on remote) ─────────────────────────────────────
check_ports_remote() {
  local server="$1"
  ssh "$server" bash <<'EOF'
AGENTS_DIR="/root/.openclaw/agents"
declare -A SEEN=()
CONFLICTS=0
for env_file in "$AGENTS_DIR"/*/docker.env; do
  [ -f "$env_file" ] || continue
  agent=$(basename "$(dirname "$env_file")")
  for key in OPENCLAW_GATEWAY_PORT OPENCLAW_BRIDGE_PORT; do
    port=$(grep -E "^${key}=" "$env_file" 2>/dev/null | cut -d= -f2 || true)
    [ -z "$port" ] && continue
    label="${key}:${port}"
    if [ -n "${SEEN[$label]:-}" ]; then
      echo "CONFLICT: Port $port ($key) used by both '${SEEN[$label]}' and '$agent'"
      CONFLICTS=$((CONFLICTS + 1))
    else
      SEEN[$label]="$agent"
    fi
  done
done
exit $CONFLICTS
EOF
}

# ── Deploy one server ────────────────────────────────────────────────────────
deploy_server() {
  local server="$1"
  local rolled=0
  local failed=0
  local failed_list=""

  echo ""
  echo "======================================================"
  echo "  Deploying ${TAG} to ${server}"
  echo "======================================================"

  # Step 1: Port conflict check
  echo ""
  echo "-> Checking for port conflicts..."
  if ! check_ports_remote "$server"; then
    echo "ERROR: Port conflicts on $server. Fix before deploying." >&2
    return 1
  fi
  echo "  OK: No port conflicts"

  # Step 1.5: Free disk — prune old, unused gateway images before pulling so the
  # pull never fails on "no space left" (image drift; each pull adds ~8.5 G).
  # Keeps in-use + the most-recent tags; all tags are re-pullable from the registry.
  echo ""
  echo "-> Pruning old unused gateway images on ${server}..."
  ssh "$server" "bash -s -- ${KEEP_RECENT}" < "${SCRIPT_DIR}/prune-gateway-images.sh" \
    || echo "  WARN: prune step failed (continuing)"

  # Step 2: Pull image
  echo ""
  echo "-> Pulling image ${IMAGE}..."
  if ! ssh "$server" "docker pull ${IMAGE}"; then
    echo "ERROR: Failed to pull image on $server" >&2
    return 1
  fi
  echo "  OK: Image pulled"

  # Step 3: Discover agents (only directories that contain a docker.env)
  echo ""
  echo "-> Discovering agents..."
  local agents
  agents=$(ssh "$server" "for d in ${AGENTS_DIR}/*/; do [ -f \"\${d}docker.env\" ] && basename \"\$d\"; done")
  local agent_count
  agent_count=$(echo "$agents" | wc -l | tr -d ' ')
  echo "  Found ${agent_count} agents"

  # Step 4: Roll out one at a time
  echo ""
  for agent in $agents; do
    local env_file="${AGENTS_DIR}/${agent}/docker.env"

    # Save current image for rollback and overwrite detection
    local prev_image
    prev_image=$(ssh "$server" "grep '^OPENCLAW_IMAGE=' '${env_file}' 2>/dev/null | cut -d= -f2" || echo "")

    # Warn if we're overwriting a different image than what we're deploying
    if [[ -n "$prev_image" && "$prev_image" != "$IMAGE" ]]; then
      echo "  ⚠️  WARNING: ${agent} is currently running a different image"
      echo "       Running: ${prev_image}"
      echo "       New:     ${IMAGE}"
    fi

    # Update image
    ssh "$server" "sed -i 's|^OPENCLAW_IMAGE=.*|OPENCLAW_IMAGE=${IMAGE}|' '${env_file}'"

    # Recreate container
    echo "  -> Rolling ${agent}..."
    ssh "$server" "cd ${COMPOSE_DIR} && docker compose -p '${agent}' --env-file '${env_file}' up -d openclaw-gateway 2>&1" || true

    # Health check: verify container is running
    local healthy=false
    for _ in 1 2 3; do
      sleep 5
      local status
      status=$(ssh "$server" "docker inspect --format='{{.State.Status}}' '${agent}-openclaw-gateway-1' 2>/dev/null" || echo "missing")
      if [[ "$status" == "running" ]]; then
        healthy=true
        break
      fi
    done

    if [[ "$healthy" == true ]]; then
      echo "     OK: ${agent} running"
      rolled=$((rolled + 1))
    else
      echo "     FAIL: ${agent} not healthy -- rolling back" >&2
      failed=$((failed + 1))
      failed_list="${failed_list} ${agent}"
      # Rollback
      if [[ -n "$prev_image" ]]; then
        ssh "$server" "sed -i 's|^OPENCLAW_IMAGE=.*|OPENCLAW_IMAGE=${prev_image}|' '${env_file}'"
        ssh "$server" "cd ${COMPOSE_DIR} && docker compose -p '${agent}' --env-file '${env_file}' up -d openclaw-gateway 2>&1" || true
        echo "     Rolled back ${agent} to ${prev_image}"
      fi
    fi
  done

  # Summary
  echo ""
  echo "------------------------------------------------------"
  echo "  ${server}: ${rolled} rolled, ${failed} failed"
  if [[ $failed -gt 0 ]]; then
    echo "  Failed agents:${failed_list}"
    echo "------------------------------------------------------"
    return 1
  fi
  echo "------------------------------------------------------"
  return 0
}

# ── Main ──────────────────────────────────────────────────────────────────────
echo "======================================================"
echo "  OpenClaw Deploy"
echo "  Tag:     ${TAG}"
echo "  Image:   ${IMAGE}"
echo "  Targets: ${SERVERS[*]}"
echo "======================================================"

OVERALL_FAIL=0
for server in "${SERVERS[@]}"; do
  deploy_server "$server" || OVERALL_FAIL=1
done

echo ""
if [[ $OVERALL_FAIL -eq 0 ]]; then
  echo "All deployments succeeded."
else
  echo "Some deployments had failures. Check output above." >&2
  exit 1
fi
