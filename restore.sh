#!/bin/bash
# =============================================================================
# OpenClaw Restore Script
# =============================================================================
# Run this from the VPS host when you need to roll back OpenClaw state.
#
# Usage:
#   ssh ubuntu@<your-vps>
#   cd ~/godwind-team-docker/openclaw
#   bash restore.sh
#
# This script MUST be run on the VPS host (as ubuntu), NOT inside Docker.
# It will auto-escalate to sudo if needed, restore your chosen files, then restart.
# After restoring it will fix file ownership back to the container user automatically.
# =============================================================================

set -euo pipefail

# --- Test hooks (no-op in production; let a test harness inject paths) ---
OC_DIR_OVERRIDE="${OC_DIR_OVERRIDE:-}"
COMPOSE_DIR_OVERRIDE="${COMPOSE_DIR_OVERRIDE:-}"
SERVICE_NAME_OVERRIDE="${SERVICE_NAME_OVERRIDE:-openclaw-gateway}"
SKIP_DOCKER_RESTART="${SKIP_DOCKER_RESTART:-}"
RESTORE_GATEWAY_DELAY_SECONDS="${RESTORE_GATEWAY_DELAY_SECONDS:-4}"

# --- Auto-escalate to root if needed ---
# .openclaw is owned by the container's node user (UID 1000), not ubuntu.
# Running as root is the cleanest way to read/write those files safely.
if [ "$EUID" -ne 0 ] && [ -z "$OC_DIR_OVERRIDE" ]; then
    echo "Root access required to manage Docker-owned files. Re-running with sudo..."
    exec sudo bash "$0" "$@"
fi

if [ -n "$OC_DIR_OVERRIDE" ]; then
    OC_DIR="$OC_DIR_OVERRIDE"
else
    OC_DIR="/home/ubuntu/.openclaw"
fi
BACKUP_ROOT="$OC_DIR/backups"
if [ -n "$COMPOSE_DIR_OVERRIDE" ]; then
    COMPOSE_DIR="$COMPOSE_DIR_OVERRIDE"
else
    COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
SERVICE_NAME="$SERVICE_NAME_OVERRIDE"

run_compose() {
    (
        cd "$COMPOSE_DIR"
        docker compose "$@"
    )
}

# Colour helpers
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo ""
echo -e "${CYAN}=============================================="
echo -e "  OpenClaw Restore Tool"
echo -e "==============================================${NC}"
echo ""

# --- Sanity check: must run on host ---
if [ ! -d "$OC_DIR" ]; then
    echo -e "${RED}ERROR: $OC_DIR not found."
    echo "This script must be run on the VPS host as ubuntu, not inside Docker.${NC}"
    exit 1
fi

# --- Main menu ---
echo "What would you like to restore?"
echo ""
echo "  1) Workspace only  — restore files from GitHub (MEMORY.md, SOUL.md, skills, etc.)"
echo "  2) Local config only — restore host-side config/state from a local snapshot"
echo "  3) Both             — restore workspace from GitHub AND config from a snapshot"
echo "  Q) Quit"
echo ""
echo "Note: Local snapshot restore is an overlay restore; newer live files absent from the snapshot are not deleted."
echo "Note: Workspace restore updates tracked files only; untracked workspace files are left in place."
echo ""
read -rp "Enter choice [1/2/3/Q]: " MAIN_CHOICE

case "${MAIN_CHOICE^^}" in
    Q)
        echo "Aborted. Nothing changed."
        exit 0
        ;;
    1|3)
        DO_WORKSPACE=true
        ;;
    2)
        DO_WORKSPACE=false
        ;;
    *)
        echo -e "${RED}Invalid choice. Aborted.${NC}"
        exit 1
        ;;
esac

case "${MAIN_CHOICE}" in
    2|3)
        DO_LOCAL=true
        ;;
    *)
        DO_LOCAL=false
        ;;
esac

# ===========================================================================
# OPTION A — Workspace restore from GitHub
# ===========================================================================
if [ "$DO_WORKSPACE" = true ]; then
    echo ""
    echo -e "${CYAN}--- Workspace Restore (GitHub) ---${NC}"
    echo ""

    WORKSPACE_DIR="$OC_DIR/workspace"

    if [ ! -d "$WORKSPACE_DIR/.git" ]; then
        echo -e "${RED}ERROR: $WORKSPACE_DIR is not a git repo. Cannot restore from GitHub.${NC}"
        DO_WORKSPACE=false
    else
        cd "$WORKSPACE_DIR"

        # Allow root to operate on this directory even though it's owned by another UID
        git config --global --add safe.directory "$WORKSPACE_DIR" 2>/dev/null || true

        # Load PAT
        if [ -f "$OC_DIR/secrets/git.env" ]; then
            # shellcheck source=/dev/null
            source "$OC_DIR/secrets/git.env"
            if [ -n "${GITHUB_PAT:-}" ]; then
                REPO_PATH=$(git remote get-url origin | sed 's|.*github.com[:/]||' | sed 's|\.git$||')
                git remote set-url origin "https://${GITHUB_PAT}@github.com/${REPO_PATH}.git"
            fi
        fi

        echo "Fetching commit history from GitHub..."
        git fetch origin main --quiet

        # Show last 10 commits
        echo ""
        echo "Last 10 commits on GitHub (most recent first):"
        echo ""
        mapfile -t COMMITS < <(git log origin/main --oneline -10 --format="%H|%ad|%s" --date=format:'%Y-%m-%d %H:%M')
        for i in "${!COMMITS[@]}"; do
            IFS='|' read -r HASH DATE MSG <<< "${COMMITS[$i]}"
            printf "  %2d) %s  %s\n" "$((i+1))" "$DATE" "$MSG"
        done
        echo ""

        read -rp "Enter commit number to restore to [1-${#COMMITS[@]}]: " COMMIT_CHOICE

        if ! [[ "$COMMIT_CHOICE" =~ ^[0-9]+$ ]] || [ "$COMMIT_CHOICE" -lt 1 ] || [ "$COMMIT_CHOICE" -gt "${#COMMITS[@]}" ]; then
            echo -e "${RED}Invalid selection. Skipping workspace restore.${NC}"
            DO_WORKSPACE=false
        else
            IFS='|' read -r SELECTED_HASH SELECTED_DATE SELECTED_MSG <<< "${COMMITS[$((COMMIT_CHOICE-1))]}"
            echo ""
            echo -e "${YELLOW}You selected commit $COMMIT_CHOICE:"
            echo "  Hash:    $SELECTED_HASH"
            echo "  Date:    $SELECTED_DATE"
            echo -e "  Message: $SELECTED_MSG${NC}"
            echo ""
            read -rp "Are you sure you want to restore the workspace to this commit? [y/N]: " CONFIRM_WS
            if [[ ! "${CONFIRM_WS,,}" =~ ^y ]]; then
                echo "Skipping workspace restore."
                DO_WORKSPACE=false
            fi
        fi
    fi
fi

# ===========================================================================
# OPTION B — Local config/state restore from snapshot
# ===========================================================================
SELECTED_SNAPSHOT=""
if [ "$DO_LOCAL" = true ]; then
    echo ""
    echo -e "${CYAN}--- Local Config Restore (Snapshot) ---${NC}"
    echo ""

    if [ ! -d "$BACKUP_ROOT" ]; then
        echo -e "${RED}No backups directory found at $BACKUP_ROOT. Cannot restore local config.${NC}"
        DO_LOCAL=false
    else
        mapfile -t SNAPSHOTS < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort -r | head -10)

        if [ ${#SNAPSHOTS[@]} -eq 0 ]; then
            echo -e "${RED}No snapshots found in $BACKUP_ROOT.${NC}"
            DO_LOCAL=false
        else
            echo "Available snapshots (most recent first):"
            echo ""
            for i in "${!SNAPSHOTS[@]}"; do
                SNAP_NAME=$(basename "${SNAPSHOTS[$i]}")
                # File count excludes .artifacts/ (image tarball + build stack live there)
                FILE_COUNT=$(find "${SNAPSHOTS[$i]}" -type f -not -path "${SNAPSHOTS[$i]}/.artifacts/*" | wc -l)
                ARTIFACT_TAG=""
                [ -d "${SNAPSHOTS[$i]}/.artifacts" ] && ARTIFACT_TAG=" [+image/stack]"
                printf "  %2d) %s  (%d files)%s\n" "$((i+1))" "$SNAP_NAME" "$FILE_COUNT" "$ARTIFACT_TAG"
            done
            echo ""

            read -rp "Enter snapshot number to restore from [1-${#SNAPSHOTS[@]}]: " SNAP_CHOICE

            if ! [[ "$SNAP_CHOICE" =~ ^[0-9]+$ ]] || [ "$SNAP_CHOICE" -lt 1 ] || [ "$SNAP_CHOICE" -gt "${#SNAPSHOTS[@]}" ]; then
                echo -e "${RED}Invalid selection. Skipping local config restore.${NC}"
                DO_LOCAL=false
            else
                SELECTED_SNAPSHOT="${SNAPSHOTS[$((SNAP_CHOICE-1))]}"
                SNAP_NAME=$(basename "$SELECTED_SNAPSHOT")
                echo ""
                echo -e "${YELLOW}You selected snapshot: $SNAP_NAME"
                echo ""
                echo "This will restore:"
                find "$SELECTED_SNAPSHOT" -type f -not -path "$SELECTED_SNAPSHOT/.artifacts/*" -not -name BACKUP-INFO.txt | sed "s|$SELECTED_SNAPSHOT/||" | sort | sed 's/^/    /'
                if [ -f "$SELECTED_SNAPSHOT/BACKUP-INFO.txt" ]; then
                    echo ""
                    echo "  Snapshot metadata (not restored):"
                    sed 's/^/    /' "$SELECTED_SNAPSHOT/BACKUP-INFO.txt"
                fi
                if [ -d "$SELECTED_SNAPSHOT/.artifacts" ]; then
                    echo ""
                    echo "  Artifacts present (NOT auto-restored — load manually if needed):"
                    find "$SELECTED_SNAPSHOT/.artifacts" -type f | sed "s|$SELECTED_SNAPSHOT/||" | sort | sed 's/^/    /'
                fi
                echo -e "${NC}"
                read -rp "Are you sure you want to restore from this snapshot? [y/N]: " CONFIRM_LOCAL
                if [[ ! "${CONFIRM_LOCAL,,}" =~ ^y ]]; then
                    echo "Skipping local config restore."
                    DO_LOCAL=false
                    SELECTED_SNAPSHOT=""
                fi
            fi
        fi
    fi
fi

# --- Bail if nothing to do ---
if [ "$DO_WORKSPACE" = false ] && [ "$DO_LOCAL" = false ]; then
    echo ""
    echo "Nothing to restore. Exiting."
    exit 0
fi

# ===========================================================================
# STOP CONTAINER
# ===========================================================================
echo ""
echo -e "${YELLOW}--> Stopping $SERVICE_NAME container...${NC}"
if [ -n "$SKIP_DOCKER_RESTART" ]; then
    echo "    Skipped (SKIP_DOCKER_RESTART set)."
else
    run_compose stop "$SERVICE_NAME" 2>/dev/null && echo "    Container stopped." || echo "    Container was not running."
fi

# ===========================================================================
# PERFORM RESTORES
# ===========================================================================

# --- Workspace restore ---
if [ "$DO_WORKSPACE" = true ]; then
    echo ""
    echo "--> Restoring workspace to commit $SELECTED_HASH ($SELECTED_DATE)..."
    cd "$OC_DIR/workspace"
    git checkout "$SELECTED_HASH" -- .
    git reset HEAD -- . 2>/dev/null || true
    echo -e "${GREEN}    ✓ Workspace restored to: $SELECTED_MSG${NC}"
fi

# --- Local config restore ---
if [ "$DO_LOCAL" = true ] && [ -n "$SELECTED_SNAPSHOT" ]; then
    echo ""
    echo "--> Restoring local config from snapshot: $(basename "$SELECTED_SNAPSHOT")..."

    # Restore each file/dir found in the snapshot
    cd "$SELECTED_SNAPSHOT"
    for item in *; do
        # BACKUP-INFO.txt is snapshot metadata, not runtime state
        [ "$item" = "BACKUP-INFO.txt" ] && continue
        SRC="$SELECTED_SNAPSHOT/$item"
        DEST="$OC_DIR/$item"
        if [ -f "$SRC" ]; then
            cp "$SRC" "$DEST"
            echo "    ✓ Restored: $item"
        elif [ -d "$SRC" ]; then
            cp -r "$SRC" "$OC_DIR/"
            echo "    ✓ Restored: $item/"
        fi
    done

    # Handle nested agents/main/agent if present
    if [ -d "$SELECTED_SNAPSHOT/agents/main/agent" ]; then
        mkdir -p "$OC_DIR/agents/main/agent"
        for f in "$SELECTED_SNAPSHOT/agents/main/agent/"*; do
            cp "$f" "$OC_DIR/agents/main/agent/"
            echo "    ✓ Restored: agents/main/agent/$(basename "$f")"
        done
    fi

    echo -e "${GREEN}    ✓ Local config restore complete.${NC}"
fi

# ===========================================================================
# FIX OWNERSHIP
# ===========================================================================
# Restoring as root can leave files owned by root. Return everything to the
# container's node user/group (same UID/GID as the original owner of .openclaw).
echo ""
echo -e "${YELLOW}--> Restoring file ownership to container user...${NC}"
OC_OWNER=$(stat -c '%u' "$OC_DIR")
OC_GROUP=$(stat -c '%g' "$OC_DIR")
chown -R "${OC_OWNER}:${OC_GROUP}" "$OC_DIR"
echo -e "${GREEN}    ✓ Ownership restored (UID ${OC_OWNER}, GID ${OC_GROUP}).${NC}"

# ===========================================================================
# REPAIR RESTORED CONFIG FOR THE CURRENT BUILD
# ===========================================================================
echo ""
echo -e "${YELLOW}--> Running doctor --fix for the restored state...${NC}"
if [ -n "$SKIP_DOCKER_RESTART" ]; then
    echo "    Skipped (SKIP_DOCKER_RESTART set)."
else
    run_compose run --rm "$SERVICE_NAME" openclaw doctor --fix --non-interactive
    echo -e "${GREEN}    ✓ Doctor repair completed.${NC}"
fi

# ===========================================================================
# RESTART CONTAINER
# ===========================================================================
echo ""
echo -e "${YELLOW}--> Restarting $SERVICE_NAME container...${NC}"
if [ -n "$SKIP_DOCKER_RESTART" ]; then
    echo "    Skipped (SKIP_DOCKER_RESTART set)."
else
    run_compose start "$SERVICE_NAME"
    echo -e "${GREEN}    ✓ Container started.${NC}"

    echo ""
    echo -e "${YELLOW}--> Waiting ${RESTORE_GATEWAY_DELAY_SECONDS}s for Gateway readiness...${NC}"
    sleep "$RESTORE_GATEWAY_DELAY_SECONDS"

    echo ""
    echo -e "${YELLOW}--> Running post-restore smoke checks...${NC}"
    run_compose exec -T "$SERVICE_NAME" sh -lc 'openclaw gateway status --deep --require-rpc'
    run_compose exec -T "$SERVICE_NAME" sh -lc 'openclaw health --verbose'
    run_compose exec -T "$SERVICE_NAME" sh -lc 'openclaw doctor --non-interactive'
    echo -e "${GREEN}    ✓ Post-restore smoke checks passed.${NC}"
fi

# --- Done ---
echo ""
echo -e "${GREEN}=============================================="
echo "  Restore complete!"
if [ "$DO_WORKSPACE" = true ]; then
    echo "  Workspace: restored to $SELECTED_DATE"
fi
if [ "$DO_LOCAL" = true ]; then
    echo "  Config:    restored from $(basename "${SELECTED_SNAPSHOT:-unknown}")"
fi
echo ""
echo "  Check dashboard to confirm everything is working."
echo -e "==============================================${NC}"
