#!/bin/bash
# =============================================================================
# OpenClaw Backup Script
# =============================================================================
# Backs up ALL critical OpenClaw state to a timestamped snapshot folder
# and pushes the workspace to GitHub.
#
# Run BEFORE any OpenClaw update, config change, or Docker image change.
# No input required — just run it.
#
# Can be run from:
#   - The VPS host:      bash ~/godwind-team-docker/openclaw/backup.sh
#   - Inside container:  bash /home/node/.openclaw/scripts/backup.sh
# =============================================================================

set -euo pipefail

# --- Resolve paths depending on where we're running ---
if [ -d "/home/ubuntu/.openclaw" ]; then
    OC_DIR="/home/ubuntu/.openclaw"
    WORKSPACE_DIR="/home/ubuntu/.openclaw/workspace"
    RUNNING_ON="host"
elif [ -d "/home/node/.openclaw" ]; then
    OC_DIR="/home/node/.openclaw"
    WORKSPACE_DIR="/home/node/.openclaw/workspace"
    RUNNING_ON="container"
else
    echo "ERROR: Cannot find .openclaw directory. Looked for /home/ubuntu/.openclaw and /home/node/.openclaw"
    exit 1
fi

STAMP=$(date +%Y-%m-%dT%H-%M-%S)
BACKUP_DIR="$OC_DIR/backups/$STAMP"
BACKUP_ROOT="$OC_DIR/backups"

echo "=============================================="
echo "  OpenClaw Backup"
echo "  $STAMP"
echo "  Running on: $RUNNING_ON"
echo "  Source:     $OC_DIR"
echo "  Snapshot:   $BACKUP_DIR"
echo "=============================================="

# --- 1. Create snapshot directory ---
mkdir -p "$BACKUP_DIR"

# --- 2. Config & state files ---
echo ""
echo "--> Snapshotting config and state..."

# Main config
cp "$OC_DIR/openclaw.json" "$BACKUP_DIR/" 2>/dev/null && echo "    ✓ openclaw.json" || echo "    ! openclaw.json not found"

# Config backup copies the gateway keeps
for bak in "$OC_DIR"/openclaw.json.bak*; do
    [ -f "$bak" ] && cp "$bak" "$BACKUP_DIR/" && echo "    ✓ $(basename $bak)"
done

# Auth profiles (THE critical one)
if [ -f "$OC_DIR/agents/main/agent/auth-profiles.json" ]; then
    mkdir -p "$BACKUP_DIR/agents/main/agent"
    cp "$OC_DIR/agents/main/agent/auth-profiles.json" "$BACKUP_DIR/agents/main/agent/"
    echo "    ✓ agents/main/agent/auth-profiles.json"
else
    echo "    ! auth-profiles.json not found"
fi

# Runtime model catalog
if [ -f "$OC_DIR/agents/main/agent/models.json" ]; then
    cp "$OC_DIR/agents/main/agent/models.json" "$BACKUP_DIR/agents/main/agent/" 2>/dev/null || true
    echo "    ✓ agents/main/agent/models.json"
fi

# Credentials (GitHub Copilot token etc)
if [ -d "$OC_DIR/credentials" ]; then
    cp -r "$OC_DIR/credentials" "$BACKUP_DIR/"
    echo "    ✓ credentials/"
fi

# Device pairing state
if [ -d "$OC_DIR/devices" ]; then
    cp -r "$OC_DIR/devices" "$BACKUP_DIR/"
    echo "    ✓ devices/ (paired.json, pending.json)"
fi

# Cron jobs
if [ -d "$OC_DIR/cron" ]; then
    cp -r "$OC_DIR/cron" "$BACKUP_DIR/"
    echo "    ✓ cron/"
fi

# Gateway identity
if [ -d "$OC_DIR/identity" ]; then
    cp -r "$OC_DIR/identity" "$BACKUP_DIR/"
    echo "    ✓ identity/"
fi

# Semantic memory vector index
if [ -f "$OC_DIR/memory/main.sqlite" ]; then
    mkdir -p "$BACKUP_DIR/memory"
    cp "$OC_DIR/memory/main.sqlite" "$BACKUP_DIR/memory/"
    echo "    ✓ memory/main.sqlite"
fi

# Exec approvals
if [ -f "$OC_DIR/exec-approvals.json" ]; then
    cp "$OC_DIR/exec-approvals.json" "$BACKUP_DIR/"
    echo "    ✓ exec-approvals.json"
fi

# Secrets (git PAT etc — needed for workspace push recovery)
if [ -d "$OC_DIR/secrets" ]; then
    cp -r "$OC_DIR/secrets" "$BACKUP_DIR/"
    echo "    ✓ secrets/"
fi

# Update check cache
if [ -f "$OC_DIR/update-check.json" ]; then
    cp "$OC_DIR/update-check.json" "$BACKUP_DIR/"
    echo "    ✓ update-check.json"
fi

echo ""
echo "    Snapshot saved to: $BACKUP_DIR"

# --- 3. Prune old snapshots (keep last 10) ---
echo ""
echo "--> Pruning old snapshots (keeping last 10)..."
SNAPSHOT_COUNT=$(ls -1d "$BACKUP_ROOT"/20* 2>/dev/null | wc -l)
if [ "$SNAPSHOT_COUNT" -gt 10 ]; then
    ls -1d "$BACKUP_ROOT"/20* | head -n $(( SNAPSHOT_COUNT - 10 )) | xargs rm -rf
    echo "    Pruned $(( SNAPSHOT_COUNT - 10 )) old snapshot(s)."
else
    echo "    $SNAPSHOT_COUNT snapshot(s) on disk — no pruning needed."
fi

# --- 4. Workspace git push ---
echo ""
echo "--> Pushing workspace to GitHub..."
if [ -d "$WORKSPACE_DIR/.git" ]; then
    cd "$WORKSPACE_DIR"

    # Load git PAT if available
    if [ -f "$OC_DIR/secrets/git.env" ]; then
        set +u
        source "$OC_DIR/secrets/git.env"
        set -u
        if [ -n "${GITHUB_PAT:-}" ]; then
            REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
            if echo "$REMOTE_URL" | grep -q "github.com"; then
                REPO_PATH=$(echo "$REMOTE_URL" | sed 's|.*github.com[:/]||' | sed 's|\.git$||')
                git remote set-url origin "https://${GITHUB_PAT}@github.com/${REPO_PATH}.git"
            fi
        fi
    fi

    git add -A
    if git diff --cached --quiet; then
        echo "    Nothing new to commit in workspace."
    else
        git commit -m "Pre-update backup $STAMP"
        echo "    Committed workspace changes."
    fi

    git push origin main
    echo "    ✓ Workspace pushed to GitHub (aguanitallc/godwind)"
else
    echo "    ! Workspace git repo not found at $WORKSPACE_DIR — skipping push"
fi

# --- 5. Summary ---
echo ""
echo "=============================================="
echo "  Backup complete!"
echo "  Snapshot: $BACKUP_DIR"
echo "  Workspace: https://github.com/aguanitallc/godwind"
echo ""
echo "  To roll back after a bad update:"
echo "    bash ~/godwind-team-docker/openclaw/restore.sh"
echo "=============================================="
