#!/usr/bin/env bash
# openclaw-update.sh — Safe, phased OpenClaw gateway + plugin update
#
# Updates npm-sourced plugins FIRST (to sync peer dependencies), then the
# gateway itself. Does NOT restart the gateway — restart must be manual so
# the operator can save session state and notify users beforehand.
#
# Prevents three common failure modes:
#   1. Peer-dependency mismatch — plugins keep an older openclaw copy in their
#      own node_modules while the gateway moves ahead, causing ABI/API drift.
#   2. Config-schema migration — a config backup is taken before any change so
#      the operator can diff and fix schema drift after the update.
#   3. Crash-loop on restart — dry-run and pre-restart validation steps let
#      you catch problems before the gateway is bounced.
#
# Usage:
#   bash openclaw-update.sh              # Update to latest
#   bash openclaw-update.sh 2026.4.2     # Update to specific version
#   bash openclaw-update.sh --dry-run    # Check only, no changes
#
# Exit codes:
#   0 - Success (or dry-run complete)
#   1 - Pre-flight check failed
#   2 - Plugin update failed
#   3 - Gateway update failed
#   4 - Validation failed (rollback may be needed)

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths — honour OPENCLAW_STATE_DIR or fall back to $HOME/.openclaw
# ---------------------------------------------------------------------------
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
EXTENSIONS_DIR="${STATE_DIR}/extensions"
CONFIG_FILE="${STATE_DIR}/openclaw.json"
# CONFIG_BACKUP is created later with mktemp (timestamp + random suffix)
# to avoid overwriting on same-day re-runs.
CONFIG_BACKUP=""

# ---------------------------------------------------------------------------
# Colour helpers (disabled when stdout is not a terminal)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; NC=''
fi

DRY_RUN=false
TARGET_VERSION=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run|-n) DRY_RUN=true; shift ;;
        --help|-h)
            cat <<'USAGE'
Usage: openclaw-update.sh [VERSION] [--dry-run]

Options:
  VERSION     Target version (default: latest from npm)
  --dry-run   Check only, don't make changes

Examples:
  openclaw-update.sh              # Update to latest
  openclaw-update.sh 2026.4.2     # Update to specific version
  openclaw-update.sh --dry-run    # Check what would happen
USAGE
            exit 0 ;;
        *) TARGET_VERSION="$1"; shift ;;
    esac
done

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
log()     { echo -e "${BLUE}[UPDATE]${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
fail()    { echo -e "${RED}✗${NC} $1"; }

confirm() {
    if [[ "${DRY_RUN}" == "true" ]]; then
        echo -e "${YELLOW}[DRY-RUN] Would prompt:${NC} $1"
        return 0
    fi
    printf '%b [y/N] ' "${BOLD}$1${NC}"
    read -r response
    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

# Portable semver extractor from a string like "openclaw 2026.4.3" or "2026.4.1-beta.1"
parse_semver() {
    echo "$1" | sed -E 's/.*([0-9]{4}\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?).*/\1/'
}

# ---------------------------------------------------------------------------
# Guard: required external tools
# ---------------------------------------------------------------------------
for tool in npm node openclaw python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        fail "Required tool not found: ${tool}"
        exit 1
    fi
done

# ============================================================================
# Phase 1: Pre-Flight Checks
# ============================================================================

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}           OpenClaw Update — Pre-Flight Checks                 ${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Current gateway version
CURRENT_VERSION=$(parse_semver "$(openclaw --version 2>/dev/null)" || echo "UNKNOWN")
log "Current gateway version: ${CURRENT_VERSION}"

# Determine target version
if [[ -z "${TARGET_VERSION}" ]]; then
    TARGET_VERSION=$(npm view openclaw version 2>/dev/null || true)
    if [[ -z "${TARGET_VERSION}" ]]; then
        fail "Could not determine latest openclaw version from npm"
        exit 1
    fi
    log "Target version (latest): ${TARGET_VERSION}"
else
    log "Target version (specified): ${TARGET_VERSION}"
fi

# Already up-to-date?
if [[ "${CURRENT_VERSION}" == "${TARGET_VERSION}" ]]; then
    success "Already at target version ${TARGET_VERSION}"
    echo ""
    echo "Nothing to do. Run with a different version to force update."
    exit 0
fi

log "Update path: ${CURRENT_VERSION} → ${TARGET_VERSION}"
echo ""

# Backup config (skip in dry-run)
if [[ -f "${CONFIG_FILE}" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
        log "[DRY-RUN] Would back up config (skipped)"
    else
        CONFIG_BACKUP="$(mktemp "${STATE_DIR}/openclaw-config-backup-$(date +%Y%m%d-%H%M%S)-XXXX.json")"
        chmod 600 "${CONFIG_BACKUP}"
        cp "${CONFIG_FILE}" "${CONFIG_BACKUP}"
        log "Backing up config to ${CONFIG_BACKUP}"
        success "Config backed up"
    fi
else
    warn "No config file found at ${CONFIG_FILE} — skipping backup"
fi
echo ""

# ============================================================================
# Phase 2: Plugin Audit
# ============================================================================

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}           Phase 2: Plugin Audit                               ${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

NPM_PLUGINS=()

# Scan extensions directory for npm-sourced plugins that bundle their own
# node_modules/openclaw — these need peer-dependency alignment.
if [[ -d "${EXTENSIONS_DIR}" ]]; then
    for plugin_dir in "${EXTENSIONS_DIR}"/*/; do
        [[ -d "${plugin_dir}" ]] || continue
        plugin_name=$(basename "${plugin_dir}")

        pkg_file="${plugin_dir}package.json"
        peer_pkg="${plugin_dir}node_modules/openclaw/package.json"

        # Skip plugins that don't ship their own openclaw peer
        [[ -f "${peer_pkg}" ]] || continue
        [[ -f "${pkg_file}" ]] || continue

        plugin_version=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' < "${pkg_file}" 2>/dev/null || echo "unknown")
        peer_version=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' < "${peer_pkg}" 2>/dev/null || echo "unknown")

        log "${plugin_name} v${plugin_version}"
        log "  Current peer: ${peer_version}"
        log "  Target peer:  ${TARGET_VERSION}"

        if [[ "${peer_version}" != "${TARGET_VERSION}" ]]; then
            warn "  Peer mismatch — will update"
            NPM_PLUGINS+=("${plugin_name}")
        else
            success "  Peer already matches target"
        fi
        echo ""
    done
fi

# Report local-only plugins (no action needed)
if [[ -d "${EXTENSIONS_DIR}" ]]; then
    for plugin_dir in "${EXTENSIONS_DIR}"/*/; do
        [[ -d "${plugin_dir}" ]] || continue
        plugin_name=$(basename "${plugin_dir}")
        peer_pkg="${plugin_dir}node_modules/openclaw/package.json"
        [[ -f "${peer_pkg}" ]] && continue  # already handled above
        success "${plugin_name}: local plugin (no npm peer update needed)"
    done
fi
echo ""

# ============================================================================
# Phase 3: Confirmation
# ============================================================================

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}           Update Plan                                         ${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

echo "The following actions will be performed:"
echo ""

if [[ ${#NPM_PLUGINS[@]} -gt 0 ]]; then
    echo "  1. Update npm-sourced plugin peers:"
    for plugin in "${NPM_PLUGINS[@]}"; do
        echo "     - ${plugin}: install openclaw@${TARGET_VERSION} as peer"
    done
else
    echo "  1. No npm plugin peer updates needed"
fi

echo "  2. Run: openclaw update (to ${TARGET_VERSION})"
echo "  3. Run validation checks"
echo ""
echo -e "${YELLOW}NOTE: This script does NOT restart the gateway.${NC}"
echo -e "${YELLOW}After completion, you must manually:${NC}"
echo "  - Save session state and notify users"
echo "  - Run: openclaw gateway restart"
echo ""

if [[ "${DRY_RUN}" == "true" ]]; then
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}           DRY RUN COMPLETE — No changes made                  ${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    exit 0
fi

if ! confirm "Proceed with update?"; then
    echo "Aborted."
    exit 0
fi

echo ""

# ============================================================================
# Phase 4: Update Plugin Peers
# ============================================================================

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}           Phase 4: Updating Plugin Peers                      ${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

for plugin in "${NPM_PLUGINS[@]}"; do
    plugin_path="${EXTENSIONS_DIR}/${plugin}"
    log "Updating ${plugin} peer dependency..."
    cd "${plugin_path}"

    if npm install "openclaw@${TARGET_VERSION}" --save-peer 2>&1; then
        success "Installed openclaw@${TARGET_VERSION} as peer for ${plugin}"
    else
        warn "  --save-peer failed; retrying without flag..."
        if npm install "openclaw@${TARGET_VERSION}" 2>&1; then
            success "Installed openclaw@${TARGET_VERSION} for ${plugin}"
        else
            fail "Failed to update peer for ${plugin}"
            exit 2
        fi
    fi

    # Verify
    peer_pkg="${plugin_path}/node_modules/openclaw/package.json"
    if [[ -f "${peer_pkg}" ]]; then
        new_peer=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' < "${peer_pkg}" 2>/dev/null || echo "FAILED")
        if [[ "${new_peer}" == "${TARGET_VERSION}" ]]; then
            success "Peer verified: ${new_peer}"
        else
            fail "Peer verification failed: expected ${TARGET_VERSION}, got ${new_peer}"
            exit 2
        fi
    fi

    # Update install record in openclaw.json
    if [[ -f "${CONFIG_FILE}" ]]; then
        log "Updating install record in openclaw.json..."
        OPENCLAW_UPD_CONFIG="${CONFIG_FILE}" \
        OPENCLAW_UPD_PLUGIN_PATH="${plugin_path}" \
        OPENCLAW_UPD_PLUGIN_NAME="${plugin}" \
        python3 <<'PYEOF'
import json, datetime, os, sys, tempfile

config_path = os.environ.get("OPENCLAW_UPD_CONFIG", "")
plugin_path = os.environ.get("OPENCLAW_UPD_PLUGIN_PATH", "")
plugin_name = os.environ.get("OPENCLAW_UPD_PLUGIN_NAME", "")

if not config_path or not plugin_path or not plugin_name:
    print("Skipping install-record update (missing env vars)", file=sys.stderr)
    sys.exit(0)

try:
    with open(config_path) as f:
        cfg = json.load(f)
except json.JSONDecodeError as e:
    # openclaw.json may contain JSON5 (comments, trailing commas) which
    # Python's strict json module cannot parse. Skip the patch step rather
    # than corrupting the file.
    print(f"WARNING: Could not parse {config_path} as strict JSON ({e}). "
          "Skipping install-record update. If your config uses JSON5 features "
          "(comments, trailing commas), edit the record manually.", file=sys.stderr)
    sys.exit(0)

pkg_path = os.path.join(plugin_path, "package.json")
if not os.path.isfile(pkg_path):
    sys.exit(0)

with open(pkg_path) as f:
    pkg = json.load(f)

version = pkg.get("version", "0.0.0")
npm_name = pkg.get("name", plugin_name)

plugins = cfg.setdefault("plugins", {})
installs = plugins.setdefault("installs", {})
record = installs.setdefault(plugin_name, {"source": "npm", "installPath": plugin_path})

record["version"] = version
record["resolvedVersion"] = version
record["spec"] = f"{npm_name}@{version}"
record["resolvedSpec"] = f"{npm_name}@{version}"
record["resolvedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

# Atomic write: write to temp file then rename to avoid corruption if interrupted
config_dir = os.path.dirname(config_path)
with tempfile.NamedTemporaryFile('w', dir=config_dir, delete=False, suffix='.tmp') as tmp_f:
    json.dump(cfg, tmp_f, indent=2)
    tmp_path = tmp_f.name
os.replace(tmp_path, config_path)

print(f"Updated install record: {plugin_name} v{version}")
PYEOF
        success "Install record updated"
    fi
    echo ""
done

cd "${HOME}"

# ============================================================================
# Phase 5: Update Gateway
# ============================================================================

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}           Phase 5: Updating Gateway                           ${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

log "Running: openclaw update --tag ${TARGET_VERSION} --no-restart"
if openclaw update --tag "${TARGET_VERSION}" --no-restart 2>&1; then
    success "Gateway update completed"
else
    fail "Gateway update failed"
    exit 3
fi

# Verify version
NEW_GATEWAY=$(parse_semver "$(openclaw --version 2>/dev/null)" || echo "UNKNOWN")
if [[ "${NEW_GATEWAY}" == "${TARGET_VERSION}" ]]; then
    success "Gateway version verified: ${NEW_GATEWAY}"
else
    warn "Gateway version: expected ${TARGET_VERSION}, got ${NEW_GATEWAY}"
fi
echo ""

# ============================================================================
# Phase 6: Pre-Restart Validation
# ============================================================================

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}           Phase 6: Pre-Restart Validation                     ${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

VALIDATION_ERRORS=0

# Check plugin peer alignment
log "Plugin peer alignment check:"
if [[ -d "${EXTENSIONS_DIR}" ]]; then
    for plugin_dir in "${EXTENSIONS_DIR}"/*/; do
        [[ -d "${plugin_dir}" ]] || continue
        peer_pkg="${plugin_dir}node_modules/openclaw/package.json"
        [[ -f "${peer_pkg}" ]] || continue
        plugin_name=$(basename "${plugin_dir}")
        peer_ver=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' < "${peer_pkg}" 2>/dev/null || echo "unknown")
        if [[ "${peer_ver}" == "${TARGET_VERSION}" ]]; then
            success "  ${plugin_name} peer: ${peer_ver} ✓"
        else
            warn "  ${plugin_name} peer: ${peer_ver} (expected ${TARGET_VERSION})"
            VALIDATION_ERRORS=$((VALIDATION_ERRORS + 1))
        fi
    done
fi
echo ""

# Config diff hint
if [[ -f "${CONFIG_BACKUP}" ]] && [[ -f "${CONFIG_FILE}" ]]; then
    if ! diff -q "${CONFIG_BACKUP}" "${CONFIG_FILE}" >/dev/null 2>&1; then
        warn "Config file changed during update. Review with:"
        echo "  diff ${CONFIG_BACKUP} ${CONFIG_FILE}"
        echo ""
    fi
fi

if [[ ${VALIDATION_ERRORS} -gt 0 ]]; then
    warn "Validation completed with ${VALIDATION_ERRORS} warning(s)"
else
    success "All validation checks passed"
fi
echo ""

if [[ ${VALIDATION_ERRORS} -gt 0 ]]; then
    fail "${VALIDATION_ERRORS} validation error(s) detected — review warnings above before restarting"
    exit 4
fi
echo ""

# ============================================================================
# Summary
# ============================================================================

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}           Update Complete — Restart Required                 ${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

echo "Summary:"
echo "  Previous version: ${CURRENT_VERSION}"
echo "  New version:      ${NEW_GATEWAY}"
echo "  Plugins updated:  ${NPM_PLUGINS[*]:-none}"
echo ""

echo -e "${YELLOW}${BOLD}NEXT STEPS:${NC}"
echo ""
echo "  1. Save session state and notify users of the update"
echo ""
echo "  2. Restart gateway:"
echo "     openclaw gateway restart"
echo ""
echo "  3. Verify core capabilities after restart:"
echo "     - Plugin loading (check gateway logs)"
echo "     - Channel connectivity (Telegram, WhatsApp, etc.)"
echo "     - Tool availability"
echo ""
echo "  4. If anything fails, check for config schema changes:"
echo "     - Config backup at: ${CONFIG_BACKUP}"
echo "     - Compare: diff ${CONFIG_BACKUP} ${CONFIG_FILE}"
echo ""

exit 0
