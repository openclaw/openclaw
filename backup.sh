#!/bin/bash
# =============================================================================
# OpenClaw Backup Script
# =============================================================================
# Backs up selected critical OpenClaw state to a timestamped snapshot folder
# and attempts to preserve the workspace through git.
#
# When run on the host, also snapshots the running Docker image and the
# build-stack files (Dockerfile.local, docker-compose.yml, docker/, .env)
# alongside config/state. All artifacts share the same 10-snapshot retention
# policy: oldest snapshot dir is pruned on the 11th run, image and stack
# files inside are pruned with it.
#
# Run BEFORE any OpenClaw update, config change, or Docker image change.
# No input required — just run it.
#
# Can be run from:
#   - The VPS host:      bash ~/godwind-team-docker/openclaw/backup.sh
#   - Inside container:  bash /home/node/.openclaw/scripts/backup.sh
#
# Image and build-stack snapshot only happen on host runs (Docker is reachable
# only from the host). Container runs still snapshot config/state and attempt
# the workspace git backup.
# =============================================================================

set -euo pipefail

# --- Test hooks (no-op in production; let a test harness inject paths) ---
# All five honor env-var overrides; if unset the script behaves exactly as before.
OC_DIR_OVERRIDE="${OC_DIR_OVERRIDE:-}"
COMPOSE_DIR_OVERRIDE="${COMPOSE_DIR_OVERRIDE:-}"
IMAGE_TAG_OVERRIDE="${IMAGE_TAG_OVERRIDE:-}"
RETENTION_MAX_OVERRIDE="${RETENTION_MAX_OVERRIDE:-}"
SKIP_GIT_PUSH="${SKIP_GIT_PUSH:-}"

# --- Resolve paths depending on where we're running ---
if [ -n "$OC_DIR_OVERRIDE" ]; then
    OC_DIR="$OC_DIR_OVERRIDE"
    WORKSPACE_DIR="$OC_DIR/workspace"
    RUNNING_ON="test"
elif [ -d "/home/ubuntu/.openclaw" ]; then
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

# --- Compose directory (host-only image+stack snapshot needs this) ---
if [ -n "$COMPOSE_DIR_OVERRIDE" ]; then
    COMPOSE_DIR="$COMPOSE_DIR_OVERRIDE"
elif [ -d "/home/ubuntu/godwind-team-docker/openclaw" ]; then
    COMPOSE_DIR="/home/ubuntu/godwind-team-docker/openclaw"
else
    COMPOSE_DIR=""
fi

# --- Docker image to snapshot ---
IMAGE_TAG="${IMAGE_TAG_OVERRIDE:-openclaw:local}"

# --- Retention ceiling (max number of snapshots kept on disk) ---
RETENTION_MAX="${RETENTION_MAX_OVERRIDE:-10}"

STAMP=$(date +%Y-%m-%dT%H-%M-%S)

# Version detection: try local CLI first (works in container), then Docker exec
VERSION_RAW=$(openclaw --version 2>/dev/null | awk '{print $2}' || true)
if [ -z "$VERSION_RAW" ] && [ -n "$COMPOSE_DIR" ] && [ -f "$COMPOSE_DIR/docker-compose.yml" ]; then
    VERSION_RAW=$(docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T openclaw-gateway sh -lc 'openclaw --version' 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)
fi
if [ -z "$VERSION_RAW" ]; then
    VERSION_RAW="unknown-version"
fi
VERSION_TAG=$(printf '%s' "$VERSION_RAW" | tr -c '[:alnum:]._+-' '_')
SNAPSHOT_NAME="${STAMP}_openclaw-v${VERSION_TAG}"
BACKUP_DIR="$OC_DIR/backups/$SNAPSHOT_NAME"
BACKUP_ROOT="$OC_DIR/backups"

echo "=============================================="
echo "  OpenClaw Backup"
echo "  $STAMP"
echo "  Version:    $VERSION_RAW"
echo "  Running on: $RUNNING_ON"
echo "  Source:     $OC_DIR"
echo "  Snapshot:   $BACKUP_DIR"
echo "  Retention:  $RETENTION_MAX snapshots"
echo "=============================================="

# --- 1. Create snapshot directory ---
mkdir -p "$BACKUP_DIR"

# --- 2. Config & state files ---
echo ""
echo "--> Snapshotting selected config and state..."

# Main config
cp "$OC_DIR/openclaw.json" "$BACKUP_DIR/" 2>/dev/null && echo "    ✓ openclaw.json" || echo "    ! openclaw.json not found"

# Config backup copies the gateway keeps
for bak in "$OC_DIR"/openclaw.json.bak*; do
    [ -f "$bak" ] && cp "$bak" "$BACKUP_DIR/" && echo "    ✓ $(basename "$bak")"
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

# QMD state (index/cache/models/sessions) for MCP-driven memory setups
if [ -d "$OC_DIR/agents" ]; then
    while IFS= read -r -d '' QMD_DIR; do
        REL_QMD_DIR="${QMD_DIR#"$OC_DIR"/}"
        DEST_PARENT="$BACKUP_DIR/$(dirname "$REL_QMD_DIR")"
        mkdir -p "$DEST_PARENT"
        cp -r "$QMD_DIR" "$DEST_PARENT/"
        echo "    ✓ ${REL_QMD_DIR}/"
    done < <(find "$OC_DIR/agents" -mindepth 2 -maxdepth 2 -type d -name qmd -print0)
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

# --- 2.5. Image + build-stack snapshot (host runs only) ---
# These live under .artifacts/ (hidden) so restore.sh's "for item in *" loop
# naturally skips them and won't dump a Docker image into ~/.openclaw/.
ARTIFACTS_DIR="$BACKUP_DIR/.artifacts"
INFO_FILE="$BACKUP_DIR/BACKUP-INFO.txt"

# Always write a visible info header so the restore menu shows useful context
{
    echo "OpenClaw backup snapshot"
    echo "  stamp:       $STAMP"
    echo "  version:     $VERSION_RAW"
    echo "  running on:  $RUNNING_ON"
    echo "  oc dir:      $OC_DIR"
    echo "  hostname:    $(hostname)"
} > "$INFO_FILE"

if [ "$RUNNING_ON" = "host" ] || [ "$RUNNING_ON" = "test" ]; then
    echo ""
    echo "--> Snapshotting Docker image and build stack..."
    mkdir -p "$ARTIFACTS_DIR"

    if command -v docker >/dev/null 2>&1; then
        IMAGE_ID=$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}' 2>/dev/null || true)
        IMAGE_SIZE=$(docker image inspect "$IMAGE_TAG" --format '{{.Size}}' 2>/dev/null || echo "0")
        if [ -n "$IMAGE_ID" ]; then
            echo "    Saving image $IMAGE_TAG ($IMAGE_ID, $(numfmt --to=iec --suffix=B "$IMAGE_SIZE" 2>/dev/null || echo "${IMAGE_SIZE} bytes") uncompressed)..."
            docker save "$IMAGE_TAG" | gzip > "$ARTIFACTS_DIR/image-${IMAGE_TAG/:/-}.tar.gz"
            COMPRESSED_SIZE=$(stat -c '%s' "$ARTIFACTS_DIR/image-${IMAGE_TAG/:/-}.tar.gz")
            echo "    ✓ image-${IMAGE_TAG/:/-}.tar.gz ($(numfmt --to=iec --suffix=B "$COMPRESSED_SIZE" 2>/dev/null || echo "${COMPRESSED_SIZE} bytes") compressed)"
            {
                echo ""
                echo "Docker image:"
                echo "  tag:         $IMAGE_TAG"
                echo "  id:          $IMAGE_ID"
                echo "  uncompressed: $(numfmt --to=iec --suffix=B "$IMAGE_SIZE" 2>/dev/null || echo "${IMAGE_SIZE} bytes")"
                echo "  compressed:   $(numfmt --to=iec --suffix=B "$COMPRESSED_SIZE" 2>/dev/null || echo "${COMPRESSED_SIZE} bytes")"
            } >> "$INFO_FILE"
        else
            echo "    ! Image $IMAGE_TAG not found locally — skipping image save."
            echo "" >> "$INFO_FILE"
            echo "Docker image: $IMAGE_TAG NOT FOUND at backup time" >> "$INFO_FILE"
        fi
    else
        echo "    ! docker not on PATH — skipping image save."
    fi

    # Build stack files
    if [ -n "$COMPOSE_DIR" ] && [ -d "$COMPOSE_DIR" ]; then
        STACK_DIR="$ARTIFACTS_DIR/build-stack"
        mkdir -p "$STACK_DIR"
        for f in Dockerfile.local docker-compose.yml .env; do
            if [ -f "$COMPOSE_DIR/$f" ]; then
                cp "$COMPOSE_DIR/$f" "$STACK_DIR/"
                echo "    ✓ build-stack/$f"
            fi
        done
        if [ -d "$COMPOSE_DIR/docker" ]; then
            cp -r "$COMPOSE_DIR/docker" "$STACK_DIR/"
            echo "    ✓ build-stack/docker/"
        fi
        {
            echo ""
            echo "Build stack source: $COMPOSE_DIR"
        } >> "$INFO_FILE"
    else
        echo "    ! Compose dir not found — skipping build-stack snapshot."
    fi
else
    echo ""
    echo "--> Skipping image/build-stack snapshot (only available on host runs)."
fi

# --- 3. Prune old snapshots (keep last RETENTION_MAX) ---
echo ""
echo "--> Pruning old snapshots (keeping last $RETENTION_MAX)..."
mapfile -t SNAPSHOT_DIRS < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort)
SNAPSHOT_COUNT=${#SNAPSHOT_DIRS[@]}
if [ "$SNAPSHOT_COUNT" -gt "$RETENTION_MAX" ]; then
    PRUNE_COUNT=$(( SNAPSHOT_COUNT - RETENTION_MAX ))
    for ((i = 0; i < PRUNE_COUNT; i++)); do
        rm -rf -- "${SNAPSHOT_DIRS[$i]}"
    done
    echo "    Pruned $PRUNE_COUNT old snapshot(s)."
else
    echo "    $SNAPSHOT_COUNT snapshot(s) on disk — no pruning needed."
fi

# --- 4. Workspace git push ---
echo ""
WORKSPACE_BACKUP_STATUS="not attempted"
WORKSPACE_REMOTE_STATUS="not attempted"
if [ -n "$SKIP_GIT_PUSH" ]; then
    echo "--> Skipping workspace git push (SKIP_GIT_PUSH set)."
    WORKSPACE_BACKUP_STATUS="skipped by SKIP_GIT_PUSH"
    WORKSPACE_REMOTE_STATUS="skipped by SKIP_GIT_PUSH"
else
    echo "--> Pushing workspace to GitHub..."
    if [ -d "$WORKSPACE_DIR/.git" ]; then
        cd "$WORKSPACE_DIR"

        # Load git PAT if available
        if [ -f "$OC_DIR/secrets/git.env" ]; then
            set +u
            # shellcheck source=/dev/null
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
            WORKSPACE_BACKUP_STATUS="no new commit needed"
        else
            git commit -m "Pre-update backup $SNAPSHOT_NAME"
            echo "    Committed workspace changes."
            WORKSPACE_BACKUP_STATUS="committed local workspace changes"
        fi

        if git remote get-url origin >/dev/null 2>&1; then
            if git push origin main 2>&1; then
                WORKSPACE_REMOTE_STATUS="pushed to origin/main"
                echo "    ✓ Workspace pushed to origin/main."
            else
                WORKSPACE_REMOTE_STATUS="push failed (continuing)"
                echo "    ! git push failed (continuing)."
            fi
        else
            echo "    ! No origin remote configured — skipping push."
            WORKSPACE_REMOTE_STATUS="no origin remote configured"
        fi
    else
        echo "    ! Workspace git repo not found at $WORKSPACE_DIR — skipping push"
        WORKSPACE_BACKUP_STATUS="workspace git repo not found"
        WORKSPACE_REMOTE_STATUS="workspace git repo not found"
    fi
fi

if [ -f "$INFO_FILE" ]; then
    {
        echo ""
        echo "Workspace backup:"
        echo "  local:       $WORKSPACE_BACKUP_STATUS"
        echo "  remote:      $WORKSPACE_REMOTE_STATUS"
    } >> "$INFO_FILE"
fi

# --- 4.5. Normalize ownership of the new snapshot ---
# If this script ran as root (sudo), make sure the snapshot ends up owned by
# the same UID/GID that owns OC_DIR.
if [ "$EUID" -eq 0 ]; then
    OC_OWNER=$(stat -c '%u' "$OC_DIR")
    OC_GROUP=$(stat -c '%g' "$OC_DIR")
    chown -R "${OC_OWNER}:${OC_GROUP}" "$BACKUP_DIR"
    echo ""
    echo "--> Snapshot ownership normalized to UID ${OC_OWNER}, GID ${OC_GROUP}."
fi

# --- 5. Summary ---
echo ""
echo "=============================================="
echo "  Backup complete!"
echo "  Snapshot: $BACKUP_DIR"
if [ -d "$ARTIFACTS_DIR" ]; then
    echo "  Artifacts: $ARTIFACTS_DIR"
fi
echo "  Workspace backup: $WORKSPACE_BACKUP_STATUS"
echo "  Workspace remote: $WORKSPACE_REMOTE_STATUS"
echo ""
echo "  To roll back after a bad update:"
echo "    bash ~/godwind-team-docker/openclaw/restore.sh"
echo "=============================================="
