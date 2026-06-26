#!/bin/bash
# Rollback script for Pi 5 "Jarvis" installation
# This script restores the system to pre-migration state

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Default backup location (can be overridden)
BACKUP_ROOT="/tmp/jarvis-backup-*"
ROLLBACK_LOG="/tmp/jarvis-rollback-$(date +%Y%m%d-%H%M%S).log"

# Find latest backup
find_latest_backup() {
    local latest_backup=""
    
    for backup in /tmp/jarvis-backup-* /tmp/jarvis-minimal-backup-*; do
        if [ -d "$backup" ]; then
            if [ -z "$latest_backup" ] || [ "$backup" -nt "$latest_backup" ]; then
                latest_backup="$backup"
            fi
        fi
    done
    
    echo "$latest_backup"
}

# Stop OpenClaw services
stop_openclaw_services() {
    log_step "Stopping OpenClaw services..."
    
    # Stop systemd user services
    if systemctl --user list-units --all | grep -q "openclaw"; then
        log_info "Stopping OpenClaw systemd services..."
        systemctl --user stop openclaw-gateway.service 2>/dev/null || true
        systemctl --user disable openclaw-gateway.service 2>/dev/null || true
    fi
    
    # Kill running processes
    log_info "Stopping running OpenClaw processes..."
    pkill -f "openclaw" 2>/dev/null || true
    
    # Wait a moment
    sleep 2
    
    # Force kill if needed
    if pgrep -f "openclaw" >/dev/null; then
        log_warn "Some OpenClaw processes still running, forcing kill..."
        pkill -9 -f "openclaw" 2>/dev/null || true
    fi
}

# Uninstall OpenClaw
uninstall_openclaw() {
    log_step "Uninstalling OpenClaw..."
    
    # Check for global npm package
    if npm list -g openclaw >/dev/null 2>&1; then
        log_info "Uninstalling global OpenClaw package..."
        npm uninstall -g openclaw 2>/dev/null || {
            log_warn "Failed to uninstall via npm"
        }
    fi
    
    # Remove binary symlinks
    if [ -f "/home/john/.npm-global/bin/openclaw" ]; then
        rm -f "/home/john/.npm-global/bin/openclaw" 2>/dev/null || true
    fi
    
    # Remove from PATH (informational)
    log_info "OpenClaw package removed"
}

# Restore from backup
restore_from_backup() {
    local backup_dir="$1"
    
    log_step "Restoring from backup: $backup_dir"
    
    if [ ! -d "$backup_dir" ]; then
        log_error "Backup directory not found: $backup_dir"
        return 1
    fi
    
    # Check what type of backup we have
    if [ -d "$backup_dir/full-backup" ]; then
        log_info "Found full backup, restoring..."
        restore_full_backup "$backup_dir/full-backup"
    elif [ -d "$backup_dir/quick-restore" ]; then
        log_info "Found quick restore backup, restoring critical files..."
        restore_quick_backup "$backup_dir/quick-restore"
    else
        log_info "Found minimal backup, restoring..."
        restore_minimal_backup "$backup_dir"
    fi
}

restore_full_backup() {
    local backup_dir="$1"
    
    log_info "Restoring full backup..."
    
    # Restore state directory
    if [ -d "$backup_dir/state" ]; then
        log_info "Restoring state directory..."
        rm -rf "/home/john/.clawdbot" 2>/dev/null || true
        cp -r "$backup_dir/state" "/home/john/.clawdbot" 2>/dev/null || {
            log_warn "Failed to restore state directory"
        }
    fi
    
    # Restore workspace
    if [ -d "$backup_dir/workspace" ]; then
        log_info "Restoring workspace..."
        rm -rf "/home/john/clawd" 2>/dev/null || true
        cp -r "$backup_dir/workspace" "/home/john/clawd" 2>/dev/null || {
            log_warn "Failed to restore workspace"
        }
    fi
    
    # Restore memory database
    if [ -d "$backup_dir/memory-db" ]; then
        log_info "Restoring memory database..."
        mkdir -p "/home/john/.clawdbot/memory"
        cp -r "$backup_dir/memory-db" "/home/john/.clawdbot/memory/lancedb" 2>/dev/null || {
            log_warn "Failed to restore memory database"
        }
    fi
    
    log_info "Full backup restored"
}

restore_quick_backup() {
    local backup_dir="$1"
    
    log_info "Restoring quick backup..."
    
    # Restore critical files
    for file in "$backup_dir"/*; do
        if [ -f "$file" ]; then
            filename=$(basename "$file")
            case "$filename" in
                "clawdbot.json")
                    log_info "Restoring configuration..."
                    mkdir -p "/home/john/.clawdbot"
                    cp "$file" "/home/john/.clawdbot/clawdbot.json" 2>/dev/null || true
                    ;;
                ".env")
                    log_info "Restoring environment file..."
                    mkdir -p "/home/john/.clawdbot"
                    cp "$file" "/home/john/.clawdbot/.env" 2>/dev/null || true
                    ;;
                "SOUL.md"|"AGENTS.md"|"TOOLS.md"|"IDENTITY.md"|"USER.md"|"HEARTBEAT.md"|"MEMORY.md")
                    log_info "Restoring workspace file: $filename"
                    mkdir -p "/home/john/clawd"
                    cp "$file" "/home/john/clawd/$filename" 2>/dev/null || true
                    ;;
                *.tar.gz)
                    log_info "Extracting archive: $filename"
                    mkdir -p "/home/john/clawd"
                    tar -xzf "$file" -C "/home/john/clawd/" 2>/dev/null || true
                    ;;
            esac
        fi
    done
    
    log_info "Quick backup restored"
}

restore_minimal_backup() {
    local backup_dir="$1"
    
    log_info "Restoring minimal backup..."
    
    # Simply copy all files
    for file in "$backup_dir"/*; do
        if [ -f "$file" ]; then
            filename=$(basename "$file")
            log_info "Restoring: $filename"
            
            # Determine destination
            case "$filename" in
                "clawdbot.json"|".env")
                    mkdir -p "/home/john/.clawdbot"
                    cp "$file" "/home/john/.clawdbot/$filename" 2>/dev/null || true
                    ;;
                *)
                    mkdir -p "/home/john/clawd"
                    cp "$file" "/home/john/clawd/$filename" 2>/dev/null || true
                    ;;
            esac
        fi
    done
    
    log_info "Minimal backup restored"
}

# Reinstall clawdbot
reinstall_clawdbot() {
    log_step "Reinstalling clawdbot..."
    
    log_info "Installing clawdbot from npm..."
    npm install -g clawdbot 2>/dev/null || {
        log_error "Failed to install clawdbot"
        return 1
    }
    
    log_info "Clawdbot reinstalled"
}

# Clean up OpenClaw directories
cleanup_openclaw() {
    log_step "Cleaning up OpenClaw directories..."
    
    # Remove .openclaw directory
    if [ -d "/home/john/.openclaw" ]; then
        log_info "Removing OpenClaw state directory..."
        rm -rf "/home/john/.openclaw" 2>/dev/null || {
            log_warn "Failed to remove .openclaw directory"
        }
    fi
    
    # Remove any remaining OpenClaw files
    log_info "Cleaning up leftover files..."
    find /home/john -name "*openclaw*" -type f 2>/dev/null | head -5 | while read -r file; do
        log_info "Removing: $file"
        rm -f "$file" 2>/dev/null || true
    done
}

# Restart services
restart_services() {
    log_step "Restarting services..."
    
    # Check if systemd service file exists
    if [ -f "/home/john/.config/systemd/user/clawdbot-gateway.service" ]; then
        log_info "Enabling and starting clawdbot systemd service..."
        systemctl --user daemon-reload 2>/dev/null || true
        systemctl --user enable clawdbot-gateway.service 2>/dev/null || true
        systemctl --user start clawdbot-gateway.service 2>/dev/null || true
    else
        log_info "Starting clawdbot gateway manually..."
        # Try to start gateway in background
        cd /home/john/.clawdbot && nohup clawdbot gateway > /tmp/clawdbot-gateway.log 2>&1 &
        log_info "Gateway started in background (log: /tmp/clawdbot-gateway.log)"
    fi
}

# Verify restoration
verify_restoration() {
    log_step "Verifying restoration..."
    
    # Check if clawdbot is installed
    if command -v clawdbot >/dev/null 2>&1; then
        log_info "✓ Clawdbot command found: $(which clawdbot)"
    else
        log_warn "✗ Clawdbot command not found"
    fi
    
    # Check state directory
    if [ -d "/home/john/.clawdbot" ]; then
        log_info "✓ State directory restored"
    else
        log_warn "✗ State directory not found"
    fi
    
    # Check workspace
    if [ -f "/home/john/clawd/SOUL.md" ]; then
        log_info "✓ Workspace restored (SOUL.md found)"
    else
        log_warn "✗ Workspace not fully restored"
    fi
    
    # Check configuration
    if [ -f "/home/john/.clawdbot/clawdbot.json" ]; then
        log_info "✓ Configuration restored"
    else
        log_warn "✗ Configuration not found"
    fi
}

# Main rollback function
rollback() {
    local backup_dir="$1"
    
    log_step "Starting rollback process"
    log_info "Using backup: $backup_dir"
    log_info "Log file: $ROLLBACK_LOG"
    
    exec > >(tee -a "$ROLLBACK_LOG") 2>&1
    
    # Execute rollback steps
    stop_openclaw_services
    uninstall_openclaw
    cleanup_openclaw
    restore_from_backup "$backup_dir"
    reinstall_clawdbot
    restart_services
    verify_restoration
    
    log_info "Rollback completed!"
}

# Interactive mode
interactive_mode() {
    echo "=== Jarvis Rollback Utility ==="
    echo ""
    
    # Find backups
    local latest_backup=$(find_latest_backup)
    local backup_count=0
    local backups=()
    
    echo "Searching for backups..."
    for backup in /tmp/jarvis-backup-* /tmp/jarvis-minimal-backup-*; do
        if [ -d "$backup" ]; then
            backups+=("$backup")
            backup_count=$((backup_count + 1))
        fi
    done
    
    if [ $backup_count -eq 0 ]; then
        echo "No backups found!"
        echo "Backups are typically in /tmp/jarvis-backup-*"
        echo ""
        read -p "Enter backup directory path: " backup_dir
    elif [ $backup_count -eq 1 ]; then
        echo "Found 1 backup: ${backups[0]}"
        echo ""
        read -p "Use this backup? [Y/n]: " choice
        if [[ "$choice" =~ ^[Nn]$ ]]; then
            read -p "Enter backup directory path: " backup_dir
        else
            backup_dir="${backups[0]}"
        fi
    else
        echo "Found $backup_count backups:"
        echo ""
        for i in "${!backups[@]}"; do
            echo "$((i+1)). ${backups[$i]}"
        done
        echo ""
        read -p "Select backup (1-$backup_count) or 'c' for custom: " choice
        
        if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le $backup_count ]; then
            backup_dir="${backups[$((choice-1))]}"
        else
            read -p "Enter backup directory path: " backup_dir
        fi
    fi
    
    # Verify backup
    if [ ! -d "$backup_dir" ]; then
        log_error "Backup directory not found: $backup_dir"
        exit 1
    fi
    
    # Confirm rollback
    echo ""
    echo "=== ROLLBACK CONFIRMATION ==="
    echo "This will:"
    echo "1. Stop and remove OpenClaw"
    echo "2. Restore from: $backup_dir"
    echo "3. Reinstall clawdbot"
    echo "4. Restart services"
    echo ""
    echo "WARNING: This will remove any changes made after the backup!"
    echo ""
    
    read -p "Are you sure you want to rollback? [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Rollback cancelled."
        exit 0
    fi
    
    # Execute rollback
    rollback "$backup_dir"
}

# Non-interactive mode
non_interactive_mode() {
    local backup_dir="$1"
    
    if [ -z "$backup_dir" ]; then
        backup_dir=$(find_latest_backup)
        
        if [ -z "$backup_dir" ]; then
            log_error "No backup found and none specified"
            exit 1
        fi
    fi
    
    rollback "$backup_dir"
}

# Show usage
show_usage() {
    echo "Usage: $0 [OPTIONS] [BACKUP_DIR]"
    echo ""
    echo "Rollback Jarvis installation to previous state"
    echo ""
    echo "Options:"
    echo "  -i, --interactive    Interactive mode (default)"
    echo "  -b, --backup DIR     Use specific backup directory"
    echo "  -h, --help           Show this help"
    echo ""
    echo "Examples:"
    echo "  $0                     # Interactive mode"
    echo "  $0 -b /tmp/jarvis-backup-20260204-120000  # Use specific backup"
    echo "  $0 /tmp/jarvis-backup-20260204-120000     # Same as above"
    echo ""
}

# Main execution
main() {
    local mode="interactive"
    local backup_dir=""
    
    # Parse arguments
    while [ $# -gt 0 ]; do
        case "$1" in
            -i|--interactive)
                mode="interactive"
                shift
                ;;
            -b|--backup)
                backup_dir="$2"
                mode="non-interactive"
                shift 2
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            -*)
                echo "Unknown option: $1"
                show_usage
                exit 1
                ;;
            *)
                backup_dir="$1"
                mode="non-interactive"
                shift
                ;;
        esac
    done
    
    case "$mode" in
        "interactive")
            interactive_mode
            ;;
        "non-interactive")
            non_interactive_mode "$backup_dir"
            ;;
    esac
}

# Run main function
main "$@"