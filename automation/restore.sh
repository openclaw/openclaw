#!/bin/bash
# Mythos Automated Restore Script
# Restores Mythos system from a backup archive

set -euo pipefail

# Configuration
BACKUP_FILE="${1:-}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
RESTORE_TEMP="/tmp/mythos_restore_$$"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Usage information
show_usage() {
    cat <<EOF
Mythos Restore Script

Usage: $0 <backup_file.tar.gz>

Arguments:
    backup_file    Path to the backup archive to restore

Examples:
    $0 /var/backups/mythos/mythos_backup_20250120_143022.tar.gz
    $0 ./mythos_backup_20250120_143022.tar.gz

Environment Variables:
    OPENCLAW_HOME    OpenClaw home directory (default: ~/.openclaw)

EOF
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if [ -z "$BACKUP_FILE" ]; then
        log_error "No backup file specified"
        show_usage
        exit 1
    fi
    
    if [ ! -f "$BACKUP_FILE" ]; then
        log_error "Backup file not found: $BACKUP_FILE"
        exit 1
    fi
    
    if [ ! -d "$OPENCLAW_HOME" ]; then
        log_info "Creating OpenClaw home directory: $OPENCLAW_HOME"
        mkdir -p "$OPENCLAW_HOME"
    fi
    
    if ! command -v tar &> /dev/null; then
        log_error "tar command not found"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Verify backup integrity
verify_backup() {
    log_info "Verifying backup integrity..."
    
    # Check SHA256 checksum if available
    local checksum_file="${BACKUP_FILE}.sha256"
    if [ -f "$checksum_file" ]; then
        if command -v sha256sum &> /dev/null; then
            if sha256sum -c "$checksum_file" &> /dev/null; then
                log_info "Backup checksum verified"
            else
                log_error "Backup checksum verification failed"
                exit 1
            fi
        elif command -v shasum &> /dev/null; then
            if shasum -c "$checksum_file" &> /dev/null; then
                log_info "Backup checksum verified"
            else
                log_error "Backup checksum verification failed"
                exit 1
            fi
        else
            log_warn "No SHA256 tool found, skipping checksum verification"
        fi
    else
        log_warn "No checksum file found, skipping verification"
    fi
}

# Create temporary directory
create_temp_dir() {
    log_info "Creating temporary directory: $RESTORE_TEMP"
    mkdir -p "$RESTORE_TEMP"
}

# Extract backup archive
extract_backup() {
    log_info "Extracting backup archive..."
    
    tar -xzf "$BACKUP_FILE" -C "$RESTORE_TEMP"
    log_info "Backup archive extracted"
    
    # Find the backup directory inside the archive
    local backup_dir=$(ls -1 "$RESTORE_TEMP" | head -1)
    BACKUP_EXTRACTED="${RESTORE_TEMP}/${backup_dir}"
    
    if [ ! -d "$BACKUP_EXTRACTED" ]; then
        log_error "Backup directory not found in archive"
        exit 1
    fi
    
    log_info "Backup directory: $BACKUP_EXTRACTED"
}

# Read manifest
read_manifest() {
    log_info "Reading backup manifest..."
    
    local manifest_file="${BACKUP_EXTRACTED}/manifest.json"
    if [ ! -f "$manifest_file" ]; then
        log_warn "Manifest file not found, proceeding with restore"
        return
    fi
    
    # Display manifest information
    if command -v jq &> /dev/null; then
        local backup_name=$(jq -r '.backup_name' "$manifest_file")
        local timestamp=$(jq -r '.timestamp' "$manifest_file")
        local file_count=$(jq -r '.files | length' "$manifest_file")
        
        log_info "Backup name: $backup_name"
        log_info "Backup timestamp: $timestamp"
        log_info "Files in backup: $file_count"
    else
        log_info "Install jq for detailed manifest information"
    fi
}

# Confirm restore
confirm_restore() {
    log_warn "This will restore Mythos from backup and overwrite existing data!"
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Restore cancelled"
        exit 0
    fi
}

# Stop Mythos services
stop_services() {
    log_info "Stopping Mythos services..."
    
    # Try to stop via systemctl (if available)
    if command -v systemctl &> /dev/null; then
        systemctl stop mythos-gateway 2>/dev/null || log_warn "Could not stop mythos-gateway service"
    fi
    
    # Try to stop via Docker (if available)
    if command -v docker &> /dev/null; then
        docker stop mythos-gateway 2>/dev/null || log_warn "Could not stop mythos-gateway container"
    fi
    
    log_info "Services stopped"
}

# Backup current state before restore
backup_current_state() {
    log_info "Backing up current state before restore..."
    
    local backup_name="pre_restore_$(date +%Y%m%d_%H%M%S)"
    local backup_path="${OPENCLAW_HOME}/backups/${backup_name}"
    
    mkdir -p "$backup_path"
    
    # Backup memory
    if [ -d "$OPENCLAW_HOME/memory" ]; then
        tar -czf "${backup_path}/memory.tar.gz" -C "$OPENCLAW_HOME/memory" .
    fi
    
    # Backup config
    if [ -f "$OPENCLAW_HOME/config.json" ]; then
        cp "$OPENCLAW_HOME/config.json" "${backup_path}/config.json"
    fi
    
    # Backup agents
    if [ -d "$OPENCLAW_HOME/agents" ]; then
        tar -czf "${backup_path}/agents.tar.gz" -C "$OPENCLAW_HOME/agents" .
    fi
    
    log_info "Current state backed up to: $backup_path"
}

# Restore memory
restore_memory() {
    log_info "Restoring memory data..."
    
    local memory_archive="${BACKUP_EXTRACTED}/memory.tar.gz"
    if [ -f "$memory_archive" ]; then
        mkdir -p "$OPENCLAW_HOME/memory"
        tar -xzf "$memory_archive" -C "$OPENCLAW_HOME/memory"
        log_info "Memory data restored"
    else
        log_warn "Memory archive not found in backup, skipping"
    fi
}

# Restore configuration
restore_config() {
    log_info "Restoring configuration..."
    
    local config_file="${BACKUP_EXTRACTED}/config.json"
    if [ -f "$config_file" ]; then
        cp "$config_file" "$OPENCLAW_HOME/config.json"
        log_info "Configuration restored"
    else
        log_warn "Configuration file not found in backup, skipping"
    fi
}

# Restore agent data
restore_agents() {
    log_info "Restoring agent data..."
    
    local agents_archive="${BACKUP_EXTRACTED}/agents.tar.gz"
    if [ -f "$agents_archive" ]; then
        mkdir -p "$OPENCLAW_HOME/agents"
        tar -xzf "$agents_archive" -C "$OPENCLAW_HOME/agents"
        log_info "Agent data restored"
    else
        log_warn "Agent archive not found in backup, skipping"
    fi
}

# Restore logs
restore_logs() {
    log_info "Restoring logs..."
    
    local logs_archive="${BACKUP_EXTRACTED}/logs.tar.gz"
    if [ -f "$logs_archive" ]; then
        mkdir -p "$OPENCLAW_HOME/logs"
        tar -xzf "$logs_archive" -C "$OPENCLAW_HOME/logs"
        log_info "Logs restored"
    else
        log_warn "Logs archive not found in backup, skipping"
    fi
}

# Set permissions
set_permissions() {
    log_info "Setting permissions..."
    
    # Set ownership (if running as root)
    if [ "$EUID" -eq 0 ]; then
        local user="${OPENCLAW_USER:-openclaw}"
        if id "$user" &>/dev/null; then
            chown -R "$user:$user" "$OPENCLAW_HOME"
            log_info "Ownership set to $user"
        fi
    fi
    
    # Set directory permissions
    find "$OPENCLAW_HOME" -type d -exec chmod 755 {} \;
    
    # Set file permissions
    find "$OPENCLAW_HOME" -type f -exec chmod 644 {} \;
    
    # Set executable permissions for scripts
    if [ -d "$OPENCLAW_HOME/scripts" ]; then
        find "$OPENCLAW_HOME/scripts" -type f -name "*.sh" -exec chmod 755 {} \;
    fi
    
    log_info "Permissions set"
}

# Validate restore
validate_restore() {
    log_info "Validating restore..."
    
    local errors=0
    
    # Check critical directories
    if [ ! -d "$OPENCLAW_HOME/memory" ]; then
        log_error "Memory directory not found after restore"
        ((errors++))
    fi
    
    if [ ! -f "$OPENCLAW_HOME/config.json" ]; then
        log_error "Configuration file not found after restore"
        ((errors++))
    fi
    
    if [ ! -d "$OPENCLAW_HOME/agents" ]; then
        log_error "Agents directory not found after restore"
        ((errors++))
    fi
    
    if [ $errors -gt 0 ]; then
        log_error "Restore validation failed with $errors errors"
        exit 1
    fi
    
    log_info "Restore validation passed"
}

# Start services
start_services() {
    log_info "Starting Mythos services..."
    
    # Try to start via systemctl
    if command -v systemctl &> /dev/null; then
        systemctl start mythos-gateway 2>/dev/null || log_warn "Could not start mythos-gateway service"
    fi
    
    # Try to start via Docker
    if command -v docker &> /dev/null; then
        docker start mythos-gateway 2>/dev/null || log_warn "Could not start mythos-gateway container"
    fi
    
    log_info "Services started"
}

# Cleanup temporary directory
cleanup() {
    log_info "Cleaning up temporary files..."
    rm -rf "$RESTORE_TEMP"
    log_info "Cleanup completed"
}

# Main execution
main() {
    if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
        show_usage
        exit 0
    fi
    
    log_info "Starting Mythos restore process..."
    log_info "Backup file: $BACKUP_FILE"
    log_info "OpenClaw home: $OPENCLAW_HOME"
    
    check_prerequisites
    verify_backup
    create_temp_dir
    extract_backup
    read_manifest
    confirm_restore
    stop_services
    backup_current_state
    restore_memory
    restore_config
    restore_agents
    restore_logs
    set_permissions
    validate_restore
    start_services
    cleanup
    
    log_info "Restore completed successfully!"
}

# Handle errors
trap 'cleanup; log_error "Restore failed at line $LINENO"' ERR

# Run main
main "$@"
