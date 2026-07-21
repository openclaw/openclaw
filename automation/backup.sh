#!/bin/bash
# Mythos Automated Backup Script
# Creates timestamped backups of memory, configuration, and agent data

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mythos}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="mythos_backup_${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if [ ! -d "$OPENCLAW_HOME" ]; then
        log_error "OpenClaw home directory not found: $OPENCLAW_HOME"
        exit 1
    fi
    
    if ! command -v tar &> /dev/null; then
        log_error "tar command not found"
        exit 1
    fi
    
    if ! command -v gzip &> /dev/null; then
        log_error "gzip command not found"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Create backup directory
create_backup_dir() {
    log_info "Creating backup directory: $BACKUP_PATH"
    mkdir -p "$BACKUP_PATH"
}

# Backup memory data
backup_memory() {
    log_info "Backing up memory data..."
    
    local memory_dir="$OPENCLAW_HOME/memory"
    if [ -d "$memory_dir" ]; then
        tar -czf "${BACKUP_PATH}/memory.tar.gz" -C "$memory_dir" .
        local size=$(du -sh "${BACKUP_PATH}/memory.tar.gz" | cut -f1)
        log_info "Memory backup completed: $size"
    else
        log_warn "Memory directory not found, skipping"
    fi
}

# Backup configuration
backup_config() {
    log_info "Backing up configuration..."
    
    local config_file="$OPENCLAW_HOME/config.json"
    if [ -f "$config_file" ]; then
        cp "$config_file" "${BACKUP_PATH}/config.json"
        log_info "Configuration backup completed"
    else
        log_warn "Configuration file not found, skipping"
    fi
}

# Backup agent data
backup_agents() {
    log_info "Backing up agent data..."
    
    local agents_dir="$OPENCLAW_HOME/agents"
    if [ -d "$agents_dir" ]; then
        tar -czf "${BACKUP_PATH}/agents.tar.gz" -C "$agents_dir" .
        local size=$(du -sh "${BACKUP_PATH}/agents.tar.gz" | cut -f1)
        log_info "Agent data backup completed: $size"
    else
        log_warn "Agents directory not found, skipping"
    fi
}

# Backup logs
backup_logs() {
    log_info "Backing up logs..."
    
    local logs_dir="$OPENCLAW_HOME/logs"
    if [ -d "$logs_dir" ]; then
        tar -czf "${BACKUP_PATH}/logs.tar.gz" -C "$logs_dir" .
        local size=$(du -sh "${BACKUP_PATH}/logs.tar.gz" | cut -f1)
        log_info "Logs backup completed: $size"
    else
        log_warn "Logs directory not found, skipping"
    fi
}

# Create backup manifest
create_manifest() {
    log_info "Creating backup manifest..."
    
    cat > "${BACKUP_PATH}/manifest.json" <<EOF
{
    "backup_name": "$BACKUP_NAME",
    "timestamp": "$(date -Iseconds)",
    "openclaw_home": "$OPENCLAW_HOME",
    "backup_path": "$BACKUP_PATH",
    "files": [
EOF

    local first=true
    for file in "${BACKUP_PATH}"/*.tar.gz "${BACKUP_PATH}"/*.json; do
        if [ -f "$file" ]; then
            local filename=$(basename "$file")
            local size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
            
            if [ "$first" = true ]; then
                first=false
            else
                echo "," >> "${BACKUP_PATH}/manifest.json"
            fi
            
            cat >> "${BACKUP_PATH}/manifest.json" <<EOF
        {
            "name": "$filename",
            "size_bytes": $size
        }
EOF
        fi
    done

    cat >> "${BACKUP_PATH}/manifest.json" <<EOF
    ]
}
EOF

    log_info "Backup manifest created"
}

# Create final archive
create_archive() {
    log_info "Creating final backup archive..."
    
    tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" -C "$BACKUP_DIR" "$BACKUP_NAME"
    local size=$(du -sh "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" | cut -f1)
    
    log_info "Backup archive created: ${BACKUP_NAME}.tar.gz ($size)"
    
    # Cleanup temporary directory
    rm -rf "$BACKUP_PATH"
    log_info "Temporary backup directory cleaned up"
}

# Rotate old backups
rotate_backups() {
    log_info "Rotating old backups (retention: ${RETENTION_DAYS} days)..."
    
    local count=$(find "$BACKUP_DIR" -name "mythos_backup_*.tar.gz" -mtime +${RETENTION_DAYS} | wc -l)
    
    if [ "$count" -gt 0 ]; then
        find "$BACKUP_DIR" -name "mythos_backup_*.tar.gz" -mtime +${RETENTION_DAYS} -delete
        log_info "Deleted $count old backups"
    else
        log_info "No old backups to delete"
    fi
}

# Generate checksum
generate_checksum() {
    log_info "Generating backup checksum..."
    
    if command -v sha256sum &> /dev/null; then
        sha256sum "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" > "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz.sha256"
    elif command -v shasum &> /dev/null; then
        shasum -a 256 "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" > "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz.sha256"
    else
        log_warn "No SHA256 tool found, skipping checksum generation"
        return
    fi
    
    log_info "Checksum generated"
}

# Main execution
main() {
    log_info "Starting Mythos backup process..."
    log_info "Backup directory: $BACKUP_DIR"
    log_info "OpenClaw home: $OPENCLAW_HOME"
    
    check_prerequisites
    create_backup_dir
    backup_memory
    backup_config
    backup_agents
    backup_logs
    create_manifest
    create_archive
    generate_checksum
    rotate_backups
    
    log_info "Backup completed successfully!"
    log_info "Backup file: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
}

# Handle errors
trap 'log_error "Backup failed at line $LINENO"' ERR

# Run main
main "$@"
