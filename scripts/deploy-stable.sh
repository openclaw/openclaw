#!/usr/bin/env bash
# Authored by: cc (Claude Code) | 2026-03-15
# Build in the dev repo and promote to the openclaw-stable worktree so the
# LaunchAgent always runs from a stable, fully self-contained copy.
#
# The stable worktree (~/../openclaw-stable) has its own node_modules symlink
# and extensions — plugin loading works identically to the dev repo.
#
# Usage:
#   pnpm deploy:stable                             # build + test + promote + restart
#   OPENCLAW_DEPLOY_SKIP_TESTS=1 pnpm deploy:stable   # skip tests
#   OPENCLAW_DEPLOY_SKIP_RESTART=1 pnpm deploy:stable # skip gateway restart
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STABLE_DIR="${REPO_DIR}/../openclaw-stable"
STABLE_DIR="$(cd "${STABLE_DIR}" 2>/dev/null && pwd || echo "${REPO_DIR}/../openclaw-stable")"
DIST_SRC="${REPO_DIR}/dist"
DIST_DEST="${STABLE_DIR}/dist"
SKIP_TESTS="${OPENCLAW_DEPLOY_SKIP_TESTS:-0}"
SKIP_RESTART="${OPENCLAW_DEPLOY_SKIP_RESTART:-0}"
LAUNCHD_LABEL="ai.openclaw.gateway"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
DESIRED_ENTRY="${DIST_DEST}/index.js"
WATCHDOG_LABELS=("ai.openclaw.watchdog" "com.openclaw.watchdog")
WATCHDOG_USER_PLIST="${HOME}/Library/LaunchAgents/ai.openclaw.watchdog.plist"
WATCHDOG_SYS_PLIST="/Library/LaunchAgents/com.openclaw.watchdog.plist"

log() { printf '[deploy-stable] %s\n' "$*"; }
die() { printf '[deploy-stable] ERROR: %s\n' "$*" >&2; exit 1; }

# ── 0. Ensure stable worktree exists ──────────────────────────────────────────
if [[ ! -d "${STABLE_DIR}" ]]; then
  log "Creating openclaw-stable worktree..."
  # Use --detach so the stable worktree doesn't need an exclusive branch
  git -C "${REPO_DIR}" worktree add --detach "${STABLE_DIR}" main
  log "Worktree created at ${STABLE_DIR}"
fi

# ── 1. Ensure node_modules symlink in stable (avoids 1.5 GB duplication) ─────
NM_DEST="${STABLE_DIR}/node_modules"
if [[ -L "${NM_DEST}" ]]; then
  log "node_modules symlink already present"
elif [[ -d "${NM_DEST}" ]]; then
  log "Removing real node_modules in stable (replacing with symlink)..."
  rm -rf "${NM_DEST}"
  ln -s "${REPO_DIR}/node_modules" "${NM_DEST}"
  log "node_modules symlink created"
else
  ln -s "${REPO_DIR}/node_modules" "${NM_DEST}"
  log "node_modules symlink created"
fi

# ── 2. Build in dev repo ──────────────────────────────────────────────────────
log "Building in dev repo..."
cd "${REPO_DIR}"
pnpm build
pnpm ui:build

# ── 3. Tests (optional) ───────────────────────────────────────────────────────
if [[ "${SKIP_TESTS}" != "1" ]]; then
  log "Running tests..."
  pnpm test:fast
else
  log "Skipping tests (OPENCLAW_DEPLOY_SKIP_TESTS=1)"
fi

# ── 4a. Sync stable worktree src/ to current HEAD ─────────────────────────────
# The gateway's plugin loader uses jiti to load src/plugins/runtime/*.ts at
# runtime. If the worktree's checkout is stale, the source files won't match
# the compiled dist/ and plugin runtime features (e.g. runtime.agent) break.
CURRENT_HEAD="$(git -C "${REPO_DIR}" rev-parse HEAD)"
STABLE_HEAD="$(git -C "${STABLE_DIR}" rev-parse HEAD 2>/dev/null || echo "none")"
if [[ "${CURRENT_HEAD}" != "${STABLE_HEAD}" ]]; then
  log "Updating stable worktree: ${STABLE_HEAD:0:12} → ${CURRENT_HEAD:0:12}"
  git -C "${STABLE_DIR}" checkout --detach "${CURRENT_HEAD}" --quiet
else
  log "Stable worktree already at ${CURRENT_HEAD:0:12}"
fi

# ── 4b. Promote dist/ to stable worktree ──────────────────────────────────────
log "Promoting dist/ → ${DIST_DEST}..."
mkdir -p "${DIST_DEST}"
rsync -a --delete "${DIST_SRC}/" "${DIST_DEST}/"
log "dist/ promoted"

# ── 5. Pause watchdog agents (prevent gateway install --force during restart) ─
for wl in "${WATCHDOG_LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/${wl}" 2>/dev/null || true
  launchctl bootout "system/${wl}" 2>/dev/null || true
done
log "Watchdog agents paused"

# ── 6. Update plist to point at stable dist ───────────────────────────────────
if [[ ! -f "${PLIST_PATH}" ]]; then
  log "WARNING: plist not found at ${PLIST_PATH} — skipping plist update"
else
  CURRENT_ENTRY="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"
  if [[ "${CURRENT_ENTRY}" != "${DESIRED_ENTRY}" ]]; then
    log "Updating plist: ${CURRENT_ENTRY} → ${DESIRED_ENTRY}"
    /usr/bin/plutil -replace 'ProgramArguments.1' -string "${DESIRED_ENTRY}" "${PLIST_PATH}"
  fi
  # Remove stale extra JS path at index 2 if doctor --fix inserted one
  INDEX2="$(/usr/bin/plutil -extract ProgramArguments.2 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"
  if [[ "${INDEX2}" == *.js ]]; then
    /usr/bin/plutil -remove 'ProgramArguments.2' "${PLIST_PATH}"
    log "Removed stale path at ProgramArguments[2]: ${INDEX2}"
  fi
  VERIFIED="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}")"
  log "Plist verified: ${VERIFIED}"
fi

# ── 7. Restart gateway ────────────────────────────────────────────────────────
if [[ "${SKIP_RESTART}" != "1" ]]; then
  log "Restarting gateway..."
  launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  sleep 3
  launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
  sleep 5
  log "Gateway restarted. Checking status..."
  openclaw gateway status --deep || log "WARNING: gateway status check failed — check ${HOME}/.openclaw/logs/gateway.log"
else
  log "Skipping gateway restart (OPENCLAW_DEPLOY_SKIP_RESTART=1)"
fi

# ── 8. Resume watchdog agents ─────────────────────────────────────────────────
[[ -f "${WATCHDOG_USER_PLIST}" ]] && launchctl bootstrap "gui/$(id -u)" "${WATCHDOG_USER_PLIST}" 2>/dev/null || true
[[ -f "${WATCHDOG_SYS_PLIST}" ]] && launchctl bootstrap "gui/$(id -u)" "${WATCHDOG_SYS_PLIST}" 2>/dev/null || true
log "Watchdog agents resumed"

log "Deploy complete. Gateway running from ${DIST_DEST}/index.js"
