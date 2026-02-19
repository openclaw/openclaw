#!/bin/bash
# OpenClaw backup and restore utility
# Backs up critical state: config, registries, sessions, credentials

set -e

OPENCLAW_HOME="${HOME}/.openclaw"
BACKUP_ROOT="${OPENCLAW_HOME}/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/backup-$TIMESTAMP"

echo "💾 OpenClaw Backup & Restore Utility"
echo "===================================="
echo ""

# Function to show usage
show_usage() {
    cat <<EOF
Usage: $0 <command> [options]

Commands:
  backup              Create a full backup
  restore <backup>    Restore from a backup
  list                List available backups
  clean [days]        Remove backups older than N days (default: 30)
  verify <backup>     Verify backup integrity

Examples:
  $0 backup
  $0 restore backup-20260219-143022
  $0 list
  $0 clean 7
  $0 verify backup-20260219-143022

Backup includes:
  - Configuration (openclaw.json)
  - Model registry
  - Provider registry
  - Tool registry
  - Auth credentials
  - Sessions (optional, use --sessions flag)
  - Logs (optional, use --logs flag)

EOF
    exit 1
}

# Function to create backup
do_backup() {
    local include_sessions=false
    local include_logs=false

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            --sessions) include_sessions=true; shift ;;
            --logs) include_logs=true; shift ;;
            *) echo "Unknown flag: $1"; show_usage ;;
        esac
    done

    echo "📦 Creating backup: $(basename "$BACKUP_DIR")"
    echo ""

    # Create backup directory
    mkdir -p "$BACKUP_DIR"

    # Backup config
    echo "Backing up configuration..."
    if [ -f "$OPENCLAW_HOME/openclaw.json" ]; then
        cp "$OPENCLAW_HOME/openclaw.json" "$BACKUP_DIR/"
        echo "  ✅ openclaw.json"
    else
        echo "  ⚠️  openclaw.json not found"
    fi

    # Backup registries
    echo ""
    echo "Backing up registries..."
    STATE_DIR="$OPENCLAW_HOME/agents/default/state"

    if [ -d "$STATE_DIR" ]; then
        mkdir -p "$BACKUP_DIR/state"

        for registry in models.json providers.json tools.json; do
            if [ -f "$STATE_DIR/$registry" ]; then
                cp "$STATE_DIR/$registry" "$BACKUP_DIR/state/"
                echo "  ✅ $registry"
            else
                echo "  ⚠️  $registry not found"
            fi
        done
    else
        echo "  ⚠️  State directory not found"
    fi

    # Backup auth credentials
    echo ""
    echo "Backing up auth credentials..."
    AUTH_DIR="$OPENCLAW_HOME/auth"

    if [ -d "$AUTH_DIR" ]; then
        mkdir -p "$BACKUP_DIR/auth"
        cp -r "$AUTH_DIR"/* "$BACKUP_DIR/auth/" 2>/dev/null || echo "  ⚠️  No auth files found"
        echo "  ✅ Auth profiles"
    else
        echo "  ⚠️  Auth directory not found"
    fi

    # Backup sessions (optional)
    if [ "$include_sessions" = true ]; then
        echo ""
        echo "Backing up sessions..."
        SESSIONS_DIR="$OPENCLAW_HOME/agents/default/sessions"

        if [ -d "$SESSIONS_DIR" ]; then
            mkdir -p "$BACKUP_DIR/sessions"
            SESSION_COUNT=$(find "$SESSIONS_DIR" -name "*.json" | wc -l)
            cp "$SESSIONS_DIR"/*.json "$BACKUP_DIR/sessions/" 2>/dev/null || true
            echo "  ✅ $SESSION_COUNT session(s)"
        else
            echo "  ⚠️  Sessions directory not found"
        fi
    fi

    # Backup logs (optional)
    if [ "$include_logs" = true ]; then
        echo ""
        echo "Backing up logs..."
        LOGS_DIR="$OPENCLAW_HOME/logs"

        if [ -d "$LOGS_DIR" ]; then
            mkdir -p "$BACKUP_DIR/logs"
            LOG_COUNT=$(find "$LOGS_DIR" -name "*.log" | wc -l)
            cp "$LOGS_DIR"/*.log "$BACKUP_DIR/logs/" 2>/dev/null || true
            echo "  ✅ $LOG_COUNT log file(s)"
        else
            echo "  ⚠️  Logs directory not found"
        fi
    fi

    # Create manifest
    echo ""
    echo "Creating backup manifest..."

    cat > "$BACKUP_DIR/manifest.json" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(hostname)",
  "openclaw_version": "$(openclaw --version 2>/dev/null || echo 'unknown')",
  "includes_sessions": $include_sessions,
  "includes_logs": $include_logs,
  "files": [
$(find "$BACKUP_DIR" -type f ! -name "manifest.json" -printf '    "%P",\n' | sed '$ s/,$//')
  ]
}
EOF

    echo "  ✅ manifest.json"

    # Calculate size
    BACKUP_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)

    echo ""
    echo "✅ Backup complete!"
    echo ""
    echo "Location: $BACKUP_DIR"
    echo "Size: $BACKUP_SIZE"
    echo ""
    echo "To restore this backup:"
    echo "  $0 restore $(basename "$BACKUP_DIR")"
    echo ""
}

# Function to restore from backup
do_restore() {
    local backup_name="$1"

    if [ -z "$backup_name" ]; then
        echo "❌ Error: Backup name required"
        echo ""
        echo "Usage: $0 restore <backup-name>"
        echo ""
        echo "Available backups:"
        do_list
        exit 1
    fi

    local backup_path="$BACKUP_ROOT/$backup_name"

    if [ ! -d "$backup_path" ]; then
        echo "❌ Error: Backup not found: $backup_name"
        echo ""
        echo "Available backups:"
        do_list
        exit 1
    fi

    echo "📥 Restoring from backup: $backup_name"
    echo ""

    # Show backup info
    if [ -f "$backup_path/manifest.json" ]; then
        echo "Backup information:"
        echo ""
        jq -r '"  Timestamp: \(.timestamp)\n  Hostname: \(.hostname)\n  OpenClaw version: \(.openclaw_version)"' "$backup_path/manifest.json"
        echo ""
    fi

    # Confirm restore
    read -p "⚠️  This will overwrite current configuration. Continue? (yes/no): " CONFIRM

    if [ "$CONFIRM" != "yes" ]; then
        echo "Restore cancelled"
        exit 0
    fi

    echo ""
    echo "Stopping OpenClaw gateway..."
    systemctl --user stop openclaw-gateway.service 2>/dev/null || true
    sleep 2

    # Create pre-restore backup
    echo ""
    echo "Creating pre-restore backup..."
    PRE_RESTORE_DIR="$BACKUP_ROOT/pre-restore-$TIMESTAMP"
    mkdir -p "$PRE_RESTORE_DIR"

    if [ -f "$OPENCLAW_HOME/openclaw.json" ]; then
        cp "$OPENCLAW_HOME/openclaw.json" "$PRE_RESTORE_DIR/" || true
    fi

    if [ -d "$OPENCLAW_HOME/agents/default/state" ]; then
        mkdir -p "$PRE_RESTORE_DIR/state"
        cp -r "$OPENCLAW_HOME/agents/default/state"/* "$PRE_RESTORE_DIR/state/" 2>/dev/null || true
    fi

    echo "  ✅ Pre-restore backup: $(basename "$PRE_RESTORE_DIR")"

    # Restore config
    echo ""
    echo "Restoring configuration..."
    if [ -f "$backup_path/openclaw.json" ]; then
        cp "$backup_path/openclaw.json" "$OPENCLAW_HOME/"
        echo "  ✅ openclaw.json"
    fi

    # Restore registries
    echo ""
    echo "Restoring registries..."
    if [ -d "$backup_path/state" ]; then
        mkdir -p "$OPENCLAW_HOME/agents/default/state"
        cp "$backup_path/state"/* "$OPENCLAW_HOME/agents/default/state/" 2>/dev/null || true
        echo "  ✅ State files"
    fi

    # Restore auth credentials
    echo ""
    echo "Restoring auth credentials..."
    if [ -d "$backup_path/auth" ]; then
        mkdir -p "$OPENCLAW_HOME/auth"
        cp -r "$backup_path/auth"/* "$OPENCLAW_HOME/auth/" 2>/dev/null || true
        echo "  ✅ Auth profiles"
    fi

    # Restore sessions (if included)
    if [ -d "$backup_path/sessions" ]; then
        echo ""
        echo "Restoring sessions..."
        mkdir -p "$OPENCLAW_HOME/agents/default/sessions"
        cp "$backup_path/sessions"/* "$OPENCLAW_HOME/agents/default/sessions/" 2>/dev/null || true
        SESSION_COUNT=$(find "$backup_path/sessions" -name "*.json" | wc -l)
        echo "  ✅ $SESSION_COUNT session(s)"
    fi

    # Restore logs (if included)
    if [ -d "$backup_path/logs" ]; then
        echo ""
        echo "Restoring logs..."
        mkdir -p "$OPENCLAW_HOME/logs"
        cp "$backup_path/logs"/* "$OPENCLAW_HOME/logs/" 2>/dev/null || true
        LOG_COUNT=$(find "$backup_path/logs" -name "*.log" | wc -l)
        echo "  ✅ $LOG_COUNT log file(s)"
    fi

    echo ""
    echo "Starting OpenClaw gateway..."
    systemctl --user start openclaw-gateway.service 2>/dev/null || true
    sleep 2

    echo ""
    echo "✅ Restore complete!"
    echo ""
    echo "If you encounter issues, you can restore the pre-restore backup:"
    echo "  $0 restore $(basename "$PRE_RESTORE_DIR")"
    echo ""
}

# Function to list backups
do_list() {
    if [ ! -d "$BACKUP_ROOT" ]; then
        echo "No backups found"
        return
    fi

    BACKUPS=$(find "$BACKUP_ROOT" -maxdepth 1 -type d -name "backup-*" -o -name "pre-restore-*" | sort -r)

    if [ -z "$BACKUPS" ]; then
        echo "No backups found"
        return
    fi

    echo "Available backups:"
    echo ""
    printf "%-30s %-20s %-10s\n" "Name" "Date" "Size"
    printf "%-30s %-20s %-10s\n" "────────────────────────────" "──────────────────" "────────"

    while IFS= read -r backup_dir; do
        BACKUP_NAME=$(basename "$backup_dir")
        BACKUP_SIZE=$(du -sh "$backup_dir" 2>/dev/null | cut -f1)
        BACKUP_DATE=$(stat -c %y "$backup_dir" 2>/dev/null | cut -d' ' -f1,2 | cut -d'.' -f1)

        printf "%-30s %-20s %-10s\n" "$BACKUP_NAME" "$BACKUP_DATE" "$BACKUP_SIZE"
    done <<< "$BACKUPS"

    echo ""
}

# Function to clean old backups
do_clean() {
    local days="${1:-30}"

    if [ ! -d "$BACKUP_ROOT" ]; then
        echo "No backups found"
        return
    fi

    echo "🧹 Cleaning backups older than $days days..."
    echo ""

    OLD_BACKUPS=$(find "$BACKUP_ROOT" -maxdepth 1 -type d -name "backup-*" -mtime +$days)

    if [ -z "$OLD_BACKUPS" ]; then
        echo "No old backups to clean"
        return
    fi

    BACKUP_COUNT=$(echo "$OLD_BACKUPS" | wc -l)

    echo "Found $BACKUP_COUNT backup(s) to remove:"
    echo "$OLD_BACKUPS" | while IFS= read -r backup; do
        echo "  - $(basename "$backup")"
    done
    echo ""

    read -p "Remove these backups? (yes/no): " CONFIRM

    if [ "$CONFIRM" = "yes" ]; then
        echo "$OLD_BACKUPS" | while IFS= read -r backup; do
            rm -rf "$backup"
            echo "  ✅ Removed: $(basename "$backup")"
        done
        echo ""
        echo "✅ Cleanup complete"
    else
        echo "Cleanup cancelled"
    fi
}

# Function to verify backup
do_verify() {
    local backup_name="$1"

    if [ -z "$backup_name" ]; then
        echo "❌ Error: Backup name required"
        show_usage
    fi

    local backup_path="$BACKUP_ROOT/$backup_name"

    if [ ! -d "$backup_path" ]; then
        echo "❌ Error: Backup not found: $backup_name"
        exit 1
    fi

    echo "🔍 Verifying backup: $backup_name"
    echo ""

    ISSUES=0

    # Check manifest
    if [ ! -f "$backup_path/manifest.json" ]; then
        echo "⚠️  Missing manifest.json"
        ((ISSUES++))
    else
        if ! jq . "$backup_path/manifest.json" >/dev/null 2>&1; then
            echo "❌ Invalid manifest.json"
            ((ISSUES++))
        else
            echo "✅ manifest.json valid"
        fi
    fi

    # Check config
    if [ ! -f "$backup_path/openclaw.json" ]; then
        echo "⚠️  Missing openclaw.json"
        ((ISSUES++))
    else
        if ! jq . "$backup_path/openclaw.json" >/dev/null 2>&1; then
            echo "❌ Invalid openclaw.json"
            ((ISSUES++))
        else
            echo "✅ openclaw.json valid"
        fi
    fi

    # Check registries
    if [ -d "$backup_path/state" ]; then
        for registry in models.json providers.json tools.json; do
            if [ -f "$backup_path/state/$registry" ]; then
                if ! jq . "$backup_path/state/$registry" >/dev/null 2>&1; then
                    echo "❌ Invalid $registry"
                    ((ISSUES++))
                else
                    echo "✅ $registry valid"
                fi
            fi
        done
    else
        echo "⚠️  No state directory"
        ((ISSUES++))
    fi

    echo ""

    if [ "$ISSUES" -eq 0 ]; then
        echo "✅ Backup verification passed"
    else
        echo "⚠️  Backup verification found $ISSUES issue(s)"
        exit 1
    fi
}

# Main command dispatcher
COMMAND="${1:-}"
shift || true

case "$COMMAND" in
    backup)
        do_backup "$@"
        ;;
    restore)
        do_restore "$@"
        ;;
    list)
        do_list
        ;;
    clean)
        do_clean "$@"
        ;;
    verify)
        do_verify "$@"
        ;;
    *)
        show_usage
        ;;
esac
