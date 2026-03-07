#!/usr/bin/env bash
# Deploy openclaw to the Mac Mini (miniclaw).
#
# Builds locally, rsyncs dist + deps to the openclaw user's repo,
# and restarts the gateway. No git pull on the remote needed.
#
# Usage: scripts/deploy-miniclaw.sh [--skip-build] [--skip-restart]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="miniclaw"
REMOTE_USER="openclaw"
REMOTE_DIR="/Users/${REMOTE_USER}/projects/openclaw-ecs"

SKIP_BUILD=0
SKIP_RESTART=0

for arg in "$@"; do
  case "${arg}" in
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--skip-build] [--skip-restart]"
      echo "  --skip-build    Skip local build, rsync existing dist/"
      echo "  --skip-restart  Deploy files but don't restart the gateway"
      exit 0
      ;;
  esac
done

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cd "${ROOT_DIR}"

# 1) Build locally
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  log "Building locally"
  pnpm build
else
  log "Skipping build (--skip-build)"
fi

[[ -f dist/entry.js ]] || fail "dist/entry.js not found — run pnpm build first"

# 2) Rsync to remote
log "Syncing to ${REMOTE_HOST}:${REMOTE_DIR}"
rsync -az --delete \
  --rsync-path="sudo rsync" \
  dist/ \
  "${REMOTE_HOST}:${REMOTE_DIR}/dist/"

rsync -az --delete \
  --rsync-path="sudo rsync" \
  node_modules/ \
  "${REMOTE_HOST}:${REMOTE_DIR}/node_modules/"

rsync -az --delete \
  --rsync-path="sudo rsync" \
  extensions/ \
  "${REMOTE_HOST}:${REMOTE_DIR}/extensions/"

# Sync essential root files
rsync -az \
  --rsync-path="sudo rsync" \
  package.json openclaw.mjs pnpm-lock.yaml pnpm-workspace.yaml \
  "${REMOTE_HOST}:${REMOTE_DIR}/"

# Fix ownership back to openclaw user
ssh "${REMOTE_HOST}" "sudo chown -R ${REMOTE_USER}:staff ${REMOTE_DIR}/dist ${REMOTE_DIR}/node_modules ${REMOTE_DIR}/extensions ${REMOTE_DIR}/package.json ${REMOTE_DIR}/openclaw.mjs ${REMOTE_DIR}/pnpm-lock.yaml ${REMOTE_DIR}/pnpm-workspace.yaml"

log "Sync complete"

# 3) Restart gateway
# The OpenClaw Mac app auto-respawns the gateway when killed (PPID=1).
# We just need to kill the old process and let the Mac app restart it
# with the newly synced dist. No manual start needed.
if [[ "${SKIP_RESTART}" -eq 0 ]]; then
  log "Restarting gateway on ${REMOTE_HOST} (kill + let Mac app respawn)"
  ssh "${REMOTE_HOST}" "sudo kill -9 \$(lsof -iTCP:18789 -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true"

  # Wait for the Mac app to respawn the gateway
  sleep 8
  log "Verifying gateway"
  ssh "${REMOTE_HOST}" "
    if lsof -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1; then
      echo \"OK: gateway listening on port 18789\"
    else
      echo \"WARN: gateway not yet listening on 18789\"
      echo \"The Mac app may need a moment to respawn, or check the app is running.\"
    fi
  "
else
  log "Skipping restart (--skip-restart)"
fi

log "Deploy complete"
