#!/usr/bin/env bash
# Authored by: cc (Claude Code) | 2026-03-15
# Deploy a successful local build to ~/.openclaw/ so the LaunchAgent
# runs from a stable deployed copy instead of the live repo dist/.
#
# Usage:
#   pnpm deploy:local                      # build + test + deploy + restart
#   OPENCLAW_DEPLOY_SKIP_TESTS=1 pnpm deploy:local   # skip tests
#   OPENCLAW_DEPLOY_SKIP_RESTART=1 pnpm deploy:local # skip gateway restart
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${HOME}/.openclaw"
DIST_SRC="${REPO_DIR}/dist"
DIST_DEST="${DEPLOY_DIR}/dist"
SKIP_TESTS="${OPENCLAW_DEPLOY_SKIP_TESTS:-0}"
SKIP_RESTART="${OPENCLAW_DEPLOY_SKIP_RESTART:-0}"
LAUNCHD_LABEL="ai.openclaw.gateway"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
NODE_MODULES_DEST="${DEPLOY_DIR}/node_modules"
SKILLS_DEST="${DEPLOY_DIR}/skills"
OPENCLAW_MJS_DEST="${DEPLOY_DIR}/openclaw.mjs"

log() { printf '[deploy-local] %s\n' "$*"; }
die() { printf '[deploy-local] ERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. Build ──────────────────────────────────────────────────────────────────
log "Building..."
cd "${REPO_DIR}"
pnpm build

# ── 2. Tests (optional) ───────────────────────────────────────────────────────
if [[ "${SKIP_TESTS}" != "1" ]]; then
  log "Running tests..."
  pnpm test:fast
else
  log "Skipping tests (OPENCLAW_DEPLOY_SKIP_TESTS=1)"
fi

# ── 3. node_modules symlink ───────────────────────────────────────────────────
# The bundled dist/ files still resolve npm packages via Node's ancestor
# node_modules lookup. We symlink ~/.openclaw/node_modules → repo node_modules
# so resolution works without copying 1.5 GB.
if [[ -L "${NODE_MODULES_DEST}" ]]; then
  CURRENT_LINK="$(readlink "${NODE_MODULES_DEST}")"
  if [[ "${CURRENT_LINK}" != "${REPO_DIR}/node_modules" ]]; then
    log "Updating node_modules symlink (was: ${CURRENT_LINK})"
    rm "${NODE_MODULES_DEST}"
    ln -s "${REPO_DIR}/node_modules" "${NODE_MODULES_DEST}"
  else
    log "node_modules symlink already correct"
  fi
elif [[ -d "${NODE_MODULES_DEST}" ]]; then
  log "Backing up existing node_modules → node_modules.pre-deploy"
  mv "${NODE_MODULES_DEST}" "${DEPLOY_DIR}/node_modules.pre-deploy"
  ln -s "${REPO_DIR}/node_modules" "${NODE_MODULES_DEST}"
  log "node_modules symlink created (backup saved)"
else
  ln -s "${REPO_DIR}/node_modules" "${NODE_MODULES_DEST}"
  log "node_modules symlink created"
fi

# ── 4. skills symlink ─────────────────────────────────────────────────────────
# resolveOpenClawPackageRootSync looks for skills/ under the package root.
# Symlink so bundled skills resolve without copying.
if [[ ! -e "${SKILLS_DEST}" ]]; then
  ln -s "${REPO_DIR}/skills" "${SKILLS_DEST}"
  log "skills symlink created"
elif [[ -L "${SKILLS_DEST}" ]]; then
  log "skills symlink already exists"
else
  log "WARNING: ${SKILLS_DEST} exists and is not a symlink — leaving it alone"
fi

# ── 5. Patch ~/.openclaw/package.json ─────────────────────────────────────────
# resolveOpenClawPackageRootSync() walks ancestor dirs looking for a package.json
# with "name": "openclaw". Without this field the runtime can't find skills/
# or control-ui assets when running from ~/.openclaw/dist/.
PKGJSON="${DEPLOY_DIR}/package.json"
if [[ -f "${PKGJSON}" ]]; then
  CURRENT_NAME="$(jq -r '.name // empty' "${PKGJSON}")"
  if [[ "${CURRENT_NAME}" != "openclaw" ]]; then
    TMPFILE="$(mktemp)"
    jq '. + {"name": "openclaw"}' "${PKGJSON}" > "${TMPFILE}"
    mv "${TMPFILE}" "${PKGJSON}"
    log "Added \"name\": \"openclaw\" to ${PKGJSON}"
  else
    log "package.json name already set"
  fi
else
  printf '{"name":"openclaw","type":"module"}\n' > "${PKGJSON}"
  log "Created minimal ${PKGJSON}"
fi

# ── 6. rsync dist/ ────────────────────────────────────────────────────────────
log "Deploying dist/ → ${DIST_DEST}..."
mkdir -p "${DIST_DEST}"
rsync -a --delete "${DIST_SRC}/" "${DIST_DEST}/"
log "dist/ deployed"

# ── 7. Copy openclaw.mjs ──────────────────────────────────────────────────────
cp "${REPO_DIR}/openclaw.mjs" "${OPENCLAW_MJS_DEST}"
log "openclaw.mjs copied"

# ── 8. Update plist ───────────────────────────────────────────────────────────
DESIRED_ENTRY="${DIST_DEST}/index.js"
if [[ ! -f "${PLIST_PATH}" ]]; then
  log "WARNING: plist not found at ${PLIST_PATH} — skipping plist update"
else
  CURRENT_ENTRY="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"
  if [[ "${CURRENT_ENTRY}" != "${DESIRED_ENTRY}" ]]; then
    log "Updating plist ProgramArguments[1]: ${CURRENT_ENTRY} → ${DESIRED_ENTRY}"
    # Must unload before editing so launchd picks up the change on bootstrap
    launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
    /usr/bin/plutil -replace 'ProgramArguments.1' -string "${DESIRED_ENTRY}" "${PLIST_PATH}"
    log "Plist updated"
  else
    log "Plist already points to correct entry"
  fi
fi

# ── 9. Restart gateway ────────────────────────────────────────────────────────
if [[ "${SKIP_RESTART}" != "1" ]]; then
  log "Restarting gateway..."
  launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
  sleep 2
  log "Gateway restarted. Checking status..."
  openclaw gateway status --deep || log "WARNING: gateway status check failed — check logs at ${DEPLOY_DIR}/logs/gateway.log"
else
  log "Skipping gateway restart (OPENCLAW_DEPLOY_SKIP_RESTART=1)"
fi

log "Deploy complete. Gateway running from ${DIST_DEST}/index.js"
