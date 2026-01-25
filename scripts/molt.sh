#!/usr/bin/env bash
#
# molt.sh - Self-healing update script for Clawdbot
#
# Usage: ./molt.sh [--dry-run]
#
# This script:
# 1. Checks for updates from upstream
# 2. Pulls, installs, builds, restarts
# 3. Verifies the gateway comes back healthy
# 4. Rolls back if something breaks
#
# Designed to be run via Clawdbot cron or system cron.

set -euo pipefail

# === Configuration ===
MOLT_DIR="${HOME}/.clawdbot/molt"
CLAWDBOT_DIR="${HOME}/clawd"
WORKSPACE_DIR="${HOME}/maja-workspace"
REMOTE="upstream"
BRANCH="main"

# Health check timing
STARTUP_TIMEOUT=60
STABILITY_WINDOW=30
PING_TIMEOUT=5

# === Parse args ===
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "[molt] DRY RUN MODE - no changes will be made"
fi

# === Helper functions ===
timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
    echo "[molt $(timestamp)] $*"
}

die() {
    log "ERROR: $*"
    exit 1
}

# === Phase 0: Preflight ===
log "=== Phase 0: Preflight ==="

# Acquire lock
LOCK_DIR="${MOLT_DIR}/lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "Another molt run in progress (lock exists), exiting"
    exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Change to repo directory
cd "$CLAWDBOT_DIR" || die "Cannot cd to $CLAWDBOT_DIR"

# Fetch from remote
log "Fetching from ${REMOTE}/${BRANCH}..."
git fetch "$REMOTE" "$BRANCH" --quiet

# Compare HEAD with remote
CURRENT_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse "${REMOTE}/${BRANCH}")

log "Current HEAD: ${CURRENT_HEAD:0:8}"
log "Remote HEAD:  ${REMOTE_HEAD:0:8}"

if [[ "$CURRENT_HEAD" == "$REMOTE_HEAD" ]]; then
    log "Already up to date"

    # Write minimal changelog
    cat > "${WORKSPACE_DIR}/update-changelog.md" << EOF
# Clawdbot Update Changelog
Generated: $(timestamp)

## Status
No changes - already up to date.

Current version: ${CURRENT_HEAD:0:8}
EOF

    exit 0
fi

# Check for clean workdir (warn but continue if dirty)
REQUIRE_CLEAN=${REQUIRE_CLEAN_WORKDIR:-false}
if [[ -n "$(git status --porcelain)" ]]; then
    log "Working directory not clean:"
    git status --short
    if [[ "$REQUIRE_CLEAN" == "true" ]]; then
        die "Aborting - commit or stash your changes first"
    else
        log "WARNING: Continuing with dirty workdir (REQUIRE_CLEAN_WORKDIR=false)"
        log "WARNING: Local changes may be lost during rollback!"
    fi
fi

# Save state for potential rollback
log "Saving pre-update state..."
echo "$CURRENT_HEAD" > "${MOLT_DIR}/pre-update-head"
cp pnpm-lock.yaml "${MOLT_DIR}/pre-update-lock.yaml" 2>/dev/null || true
git log --oneline -1 > "${MOLT_DIR}/pre-update-info"

# Count incoming commits
COMMIT_COUNT=$(git rev-list --count "${CURRENT_HEAD}..${REMOTE_HEAD}")
log "Incoming commits: $COMMIT_COUNT"

if $DRY_RUN; then
    log "[DRY RUN] Would update from ${CURRENT_HEAD:0:8} to ${REMOTE_HEAD:0:8}"
    log "[DRY RUN] Incoming changes:"
    git log --oneline "${CURRENT_HEAD}..${REMOTE_HEAD}"
    exit 0
fi

# === Phase 1: Update ===
log "=== Phase 1: Update ==="

# Merge (fast-forward only)
log "Merging ${REMOTE}/${BRANCH}..."
if ! git merge "${REMOTE}/${BRANCH}" --ff-only; then
    die "Merge failed - history has diverged. Manual intervention required."
fi

NEW_HEAD=$(git rev-parse HEAD)
log "Updated to: ${NEW_HEAD:0:8}"

# Install dependencies
log "Installing dependencies..."
if ! pnpm install --frozen-lockfile --prefer-offline 2>&1; then
    log "pnpm install failed, attempting recovery..."
    # Recovery: try without --frozen-lockfile in case lockfile is out of sync
    if ! pnpm install --prefer-offline 2>&1; then
        log "pnpm install still failed, rolling back..."
        source "${MOLT_DIR}/molt.sh" --rollback-internal
        die "pnpm install failed"
    fi
fi

# Build
log "Building..."
if ! pnpm build 2>&1; then
    log "Build failed, rolling back..."
    git checkout "$CURRENT_HEAD" --quiet
    pnpm install --frozen-lockfile --prefer-offline 2>&1 || true
    die "Build failed"
fi

# Generate changelog before restart
log "Generating changelog..."
cat > "${WORKSPACE_DIR}/update-changelog.md" << EOF
# Clawdbot Update Changelog
Generated: $(timestamp)

## Summary
Updated from \`${CURRENT_HEAD:0:8}\` to \`${NEW_HEAD:0:8}\` ($COMMIT_COUNT commits)

## Commits
$(git log --oneline "${CURRENT_HEAD}..${NEW_HEAD}")

## Changed Files
$(git diff --stat "${CURRENT_HEAD}..${NEW_HEAD}" | tail -20)
EOF

# Restart gateway
log "Restarting gateway..."
systemctl --user restart clawdbot-gateway.service

# === Phase 2: Verify ===
log "=== Phase 2: Verify ==="

# Wait for gateway to respond
log "Waiting for gateway to come up (timeout: ${STARTUP_TIMEOUT}s)..."
waited=0
gateway_up=false

while [[ $waited -lt $STARTUP_TIMEOUT ]]; do
    if systemctl --user is-active --quiet clawdbot-gateway.service; then
        # Service is running, check RPC probe via daemon status
        if cd "$CLAWDBOT_DIR" && node dist/entry.js daemon status 2>&1 | grep -q "RPC probe: ok"; then
            gateway_up=true
            break
        fi
    fi
    sleep 5
    waited=$((waited + 5))
    log "  ...waiting ($waited/${STARTUP_TIMEOUT}s)"
done

if ! $gateway_up; then
    log "Gateway didn't come up within ${STARTUP_TIMEOUT}s"

    # Capture logs
    log "Capturing crash logs..."
    journalctl --user -u clawdbot-gateway.service -n 100 --no-pager > "${MOLT_DIR}/crash-log.txt" 2>&1 || true

    # Attempt rollback
    log "Attempting rollback..."
    git checkout "$CURRENT_HEAD" --quiet
    pnpm install --frozen-lockfile --prefer-offline 2>&1 || pnpm install 2>&1 || true
    pnpm build 2>&1 || true
    systemctl --user restart clawdbot-gateway.service

    sleep 10
    if systemctl --user is-active --quiet clawdbot-gateway.service; then
        log "Rollback successful - gateway is running on ${CURRENT_HEAD:0:8}"

        # Update changelog to reflect rollback
        cat >> "${WORKSPACE_DIR}/update-changelog.md" << EOF

## ROLLBACK
Update failed - rolled back to \`${CURRENT_HEAD:0:8}\`
Gateway didn't come up after update.
See crash log: ~/.clawdbot/molt/crash-log.txt
EOF

        die "Update failed, rolled back successfully"
    else
        log "CRITICAL: Rollback also failed!"

        # Write recovery doc
        cat > "${MOLT_DIR}/RECOVERY.md" << EOF
# Molt Recovery Required

The nightly update failed and automatic rollback also failed.

## What happened
- Update started at: $(cat "${MOLT_DIR}/pre-update-info" 2>/dev/null || echo "unknown")
- Old HEAD: ${CURRENT_HEAD}
- New HEAD: ${NEW_HEAD} (attempted)
- Error: Gateway didn't start

## Crash log
See: ~/.clawdbot/molt/crash-log.txt

## Manual recovery steps
1. Check the crash log for the root cause
2. Try: \`cd ~/clawd && git checkout ${CURRENT_HEAD} && pnpm install && pnpm build && systemctl --user restart clawdbot-gateway\`
3. If that fails, see ~/clawd/CLAUDE.md for nuclear options

## Context for AI recovery
The gateway failed to start after update. Common causes:
- Missing dependency (check for "Cannot find module" in logs)
- Syntax error in new code (check for "SyntaxError" in logs)
- Config incompatibility (check for "Invalid config" in logs)
EOF

        die "CRITICAL: Both update and rollback failed. Manual intervention required. See ~/.clawdbot/molt/RECOVERY.md"
    fi
fi

# Stability window
log "Gateway up! Waiting ${STABILITY_WINDOW}s for stability..."
sleep "$STABILITY_WINDOW"

# Check still running after stability window
if ! systemctl --user is-active --quiet clawdbot-gateway.service; then
    log "Gateway crashed during stability window"
    journalctl --user -u clawdbot-gateway.service -n 100 --no-pager > "${MOLT_DIR}/crash-log.txt" 2>&1 || true

    # Rollback
    git checkout "$CURRENT_HEAD" --quiet
    pnpm install --frozen-lockfile --prefer-offline 2>&1 || pnpm install 2>&1 || true
    pnpm build 2>&1 || true
    systemctl --user restart clawdbot-gateway.service

    cat >> "${WORKSPACE_DIR}/update-changelog.md" << EOF

## ROLLBACK
Update failed - crashed during stability window. Rolled back to \`${CURRENT_HEAD:0:8}\`
See crash log: ~/.clawdbot/molt/crash-log.txt
EOF

    die "Gateway crashed during stability window, rolled back"
fi

# Final health check
if ! (cd "$CLAWDBOT_DIR" && node dist/entry.js daemon status 2>&1 | grep -q "RPC probe: ok"); then
    log "Gateway running but not responding to RPC probe"
    # Don't rollback for this - it's running, just maybe slow
    log "Warning: RPC probe failed, but service is active"
fi

# === Phase 3: Report ===
log "=== Phase 3: Success ==="

# Update last-good
echo "$NEW_HEAD" > "${MOLT_DIR}/last-good"

# Log to history
echo "{\"timestamp\":\"$(timestamp)\",\"from\":\"${CURRENT_HEAD}\",\"to\":\"${NEW_HEAD}\",\"commits\":${COMMIT_COUNT},\"status\":\"success\"}" >> "${MOLT_DIR}/history.jsonl"

log "Update complete!"
log "  From: ${CURRENT_HEAD:0:8}"
log "  To:   ${NEW_HEAD:0:8}"
log "  Commits: $COMMIT_COUNT"
log ""
log "Changelog written to: ${WORKSPACE_DIR}/update-changelog.md"

# Final summary for the agent to parse
echo ""
echo "=== MOLT SUMMARY ==="
echo "STATUS: SUCCESS"
echo "FROM: ${CURRENT_HEAD:0:8}"
echo "TO: ${NEW_HEAD:0:8}"
echo "COMMITS: $COMMIT_COUNT"
echo "CHANGELOG: ${WORKSPACE_DIR}/update-changelog.md"
