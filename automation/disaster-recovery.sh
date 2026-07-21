#!/bin/bash
# Mythos Disaster Recovery Script
# Complete system recovery from backup with validation and service restoration

set -euo pipefail

# Configuration
BACKUP_FILE="${1:-}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
RESTORE_TEMP="/tmp/mythos_dr_$$"
RECOVERY_LOG="/var/log/mythos_recovery_$(date +%Y%m%d_%H%M%S).log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1" | tee -a "$RECOVERY_LOG"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$RECOVERY_LOG"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$RECOVERY_LOG"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1" | tee -a "$RECOVERY_LOG"
}

log_critical() {
    echo -e "${MAGENTA}[CRITICAL]${NC} $1" | tee -a "$RECOVERY_LOG"
}

show_usage() {
    cat <<EOF
Mythos Disaster Recovery Script

Usage: $0 <backup_file.tar.gz> [OPTIONS]

Arguments:
    backup_file          Path to the backup archive

Options:
    --force              Skip confirmation prompts
    --skip-validation    Skip post-restore validation
    --keep-stopped       Don't restart services after recovery
    --dry-run            Simulate recovery without making changes
    --help, -h           Show this help message

Examples:
    $0 /backup/mythos_20250120.tar.gz
    $0 /backup/mythos_20250120.tar.gz --force
    $0 /backup/mythos_20250120.tar.gz --dry-run

Disaster Recovery Process:
    1. Validate backup integrity
    2. Stop all Mythos services
    3. Backup current state (safety net)
    4. Extract and restore all components
    5. Rebuild memory indexes
    6. Validate system integrity
    7. Restart services
    8. Run health checks

Environment Variables:
    OPENCLAW_HOME        OpenClaw home directory (default: ~/.openclaw)

EOF
}

# Parse arguments
FORCE=false
SKIP_VALIDATION=false
KEEP_STOPPED=false
DRY_RUN=false

if [ $# -eq 0 ]; then
    show_usage
    exit 1
fi

BACKUP_FILE="$1"
shift

while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE=true
            shift
            ;;
        --skip-validation)
            SKIP_VALIDATION=true
            shift
            ;;
        --keep-stopped)
            KEEP_STOPPED=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Initialize recovery log
mkdir -p "$(dirname "$RECOVERY_LOG")"
echo "Mythos Disaster Recovery Log - $(date)" > "$RECOVERY_LOG"
echo "===========================================" >> "$RECOVERY_LOG"

# Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."
    
    # Check backup file
    if [ ! -f "$BACKUP_FILE" ]; then
        log_error "Backup file not found: $BACKUP_FILE"
        exit 1
    fi
    
    # Check required commands
    local required_cmds=("tar" "gzip" "jq" "openssl")
    for cmd in "${required_cmds[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            log_error "Required command not found: $cmd"
            exit 1
        fi
    done
    
    # Check disk space
    local backup_size=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE" 2>/dev/null)
    local required_space=$((backup_size * 3))  # Need 3x backup size for extraction
    local available_space=$(df -k "$OPENCLAW_HOME" | tail -1 | awk '{print $4}')
    
    if [ "$available_space" -lt "$required_space" ]; then
        log_error "Insufficient disk space"
        log_error "Required: $((required_space / 1024)) KB"
        log_error "Available: $((available_space / 1024)) KB"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
    log_info "Backup size: $((backup_size / 1024 / 1024)) MB"
    log_info "Available space: $((available_space / 1024 / 1024)) MB"
}

# Validate backup integrity
validate_backup() {
    log_step "Validating backup integrity..."
    
    # Check archive format
    if ! tar -tzf "$BACKUP_FILE" &> /dev/null; then
        log_error "Invalid tar.gz archive"
        exit 1
    fi
    
    # Verify checksum if available
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
        fi
    else
        log_warn "No checksum file found, skipping verification"
    fi
    
    # List archive contents
    log_info "Archive contents:"
    tar -tzf "$BACKUP_FILE" | head -20 | while read -r line; do
        echo "  $line" | tee -a "$RECOVERY_LOG"
    done
    
    log_info "Backup validation passed"
}

# Confirm recovery
confirm_recovery() {
    if [ "$FORCE" = true ]; then
        log_info "Force mode enabled, skipping confirmation"
        return
    fi
    
    log_critical "DISASTER RECOVERY WILL:"
    log_critical "  - Stop all Mythos services"
    log_critical "  - Overwrite existing configuration"
    log_critical "  - Replace all memory data"
    log_critical "  - Restore agent states"
    log_critical ""
    log_critical "This operation CANNOT be undone!"
    echo ""
    read -p "Type 'RECOVER' to proceed: " confirm
    
    if [ "$confirm" != "RECOVER" ]; then
        log_info "Recovery cancelled"
        exit 0
    fi
}

# Stop all services
stop_all_services() {
    log_step "Stopping all Mythos services..."
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would stop services"
        return
    fi
    
    # Stop gateway
    if command -v systemctl &> /dev/null; then
        systemctl stop mythos-gateway 2>/dev/null && log_info "Gateway service stopped" || true
    fi
    
    # Stop Docker containers
    if command -v docker &> /dev/null; then
        docker stop mythos-gateway 2>/dev/null && log_info "Gateway container stopped" || true
        docker stop mythos-postgres 2>/dev/null && log_info "PostgreSQL container stopped" || true
        docker stop mythos-redis 2>/dev/null && log_info "Redis container stopped" || true
    fi
    
    # Kill any remaining processes
    pkill -f "mythos-gateway" 2>/dev/null || true
    pkill -f "openclaw" 2>/dev/null || true
    
    sleep 2
    log_info "All services stopped"
}

# Create safety backup
create_safety_backup() {
    log_step "Creating safety backup of current state..."
    
    local safety_dir="$OPENCLAW_HOME/backups/pre_disaster_recovery_$(date +%Y%m%d_%H%M%S)"
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would create safety backup at: $safety_dir"
        return
    fi
    
    mkdir -p "$safety_dir"
    
    # Backup memory
    if [ -d "$OPENCLAW_HOME/memory" ]; then
        tar -czf "${safety_dir}/memory.tar.gz" -C "$OPENCLAW_HOME/memory" . 2>/dev/null || true
    fi
    
    # Backup config
    if [ -f "$OPENCLAW_HOME/config.json" ]; then
        cp "$OPENCLAW_HOME/config.json" "${safety_dir}/config.json" 2>/dev/null || true
    fi
    
    # Backup agents
    if [ -d "$OPENCLAW_HOME/agents" ]; then
        tar -czf "${safety_dir}/agents.tar.gz" -C "$OPENCLAW_HOME/agents" . 2>/dev/null || true
    fi
    
    log_info "Safety backup created: $safety_dir"
}

# Extract backup
extract_backup() {
    log_step "Extracting backup archive..."
    
    mkdir -p "$RESTORE_TEMP"
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would extract to: $RESTORE_TEMP"
        return
    fi
    
    tar -xzf "$BACKUP_FILE" -C "$RESTORE_TEMP"
    
    # Find backup directory
    local backup_dir=$(ls -1 "$RESTORE_TEMP" | head -1)
    RESTORE_SOURCE="${RESTORE_TEMP}/${backup_dir}"
    
    if [ ! -d "$RESTORE_SOURCE" ]; then
        log_error "Backup directory not found in archive"
        exit 1
    fi
    
    log_info "Backup extracted to: $RESTORE_SOURCE"
}

# Restore memory
restore_memory() {
    log_step "Restoring memory data..."
    
    local memory_archive="${RESTORE_SOURCE}/memory.tar.gz"
    
    if [ ! -f "$memory_archive" ]; then
        log_warn "Memory archive not found in backup"
        return
    fi
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would restore memory data"
        return
    fi
    
    rm -rf "$OPENCLAW_HOME/memory"
    mkdir -p "$OPENCLAW_HOME/memory"
    tar -xzf "$memory_archive" -C "$OPENCLAW_HOME/memory"
    
    log_info "Memory data restored"
}

# Restore configuration
restore_configuration() {
    log_step "Restoring configuration..."
    
    local config_file="${RESTORE_SOURCE}/config.json"
    
    if [ ! -f "$config_file" ]; then
        log_warn "Configuration file not found in backup"
        return
    fi
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would restore configuration"
        return
    fi
    
    cp "$config_file" "$OPENCLAW_HOME/config.json"
    
    log_info "Configuration restored"
}

# Restore agents
restore_agents() {
    log_step "Restoring agent data..."
    
    local agents_archive="${RESTORE_SOURCE}/agents.tar.gz"
    
    if [ ! -f "$agents_archive" ]; then
        log_warn "Agent archive not found in backup"
        return
    fi
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would restore agent data"
        return
    fi
    
    rm -rf "$OPENCLAW_HOME/agents"
    mkdir -p "$OPENCLAW_HOME/agents"
    tar -xzf "$agents_archive" -C "$OPENCLAW_HOME/agents"
    
    log_info "Agent data restored"
}

# Rebuild indexes
rebuild_indexes() {
    log_step "Rebuilding memory indexes..."
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would rebuild indexes"
        return
    fi
    
    # Rebuild vector index
    if command -v openclaw &> /dev/null; then
        log_info "Rebuilding vector index..."
        openclaw memory rebuild --engine rust-hnsw 2>&1 | tee -a "$RECOVERY_LOG" || log_warn "Vector index rebuild failed"
        
        log_info "Rebuilding text index..."
        openclaw memory rebuild --engine rust-tantivy 2>&1 | tee -a "$RECOVERY_LOG" || log_warn "Text index rebuild failed"
    else
        log_warn "openclaw command not found, skipping index rebuild"
        log_info "You will need to rebuild indexes manually after recovery"
    fi
}

# Validate system
validate_system() {
    if [ "$SKIP_VALIDATION" = true ]; then
        log_info "Skipping validation (--skip-validation)"
        return
    fi
    
    log_step "Validating restored system..."
    
    local errors=0
    
    # Check critical directories
    if [ ! -d "$OPENCLAW_HOME/memory" ]; then
        log_error "Memory directory missing"
        ((errors++))
    fi
    
    if [ ! -f "$OPENCLAW_HOME/config.json" ]; then
        log_error "Configuration file missing"
        ((errors++))
    fi
    
    if [ ! -d "$OPENCLAW_HOME/agents" ]; then
        log_error "Agents directory missing"
        ((errors++))
    fi
    
    # Validate config JSON
    if ! jq empty "$OPENCLAW_HOME/config.json" 2>/dev/null; then
        log_error "Configuration file has invalid JSON"
        ((errors++))
    fi
    
    # Check critical config values
    if ! jq -e '.gateway.token' "$OPENCLAW_HOME/config.json" &> /dev/null; then
        log_warn "Gateway token not found in config"
    fi
    
    if [ $errors -gt 0 ]; then
        log_error "System validation failed with $errors errors"
        exit 1
    fi
    
    log_info "System validation passed"
}

# Start services
start_services() {
    if [ "$KEEP_STOPPED" = true ]; then
        log_info "Services left stopped (--keep-stopped)"
        return
    fi
    
    log_step "Starting services..."
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would start services"
        return
    fi
    
    # Start Docker containers first
    if command -v docker &> /dev/null; then
        docker start mythos-postgres 2>/dev/null && log_info "PostgreSQL started" || true
        sleep 5  # Wait for PostgreSQL to be ready
        
        docker start mythos-redis 2>/dev/null && log_info "Redis started" || true
        sleep 2
    fi
    
    # Start gateway
    if command -v systemctl &> /dev/null; then
        systemctl start mythos-gateway 2>/dev/null && log_info "Gateway service started" || true
    fi
    
    if command -v docker &> /dev/null; then
        docker start mythos-gateway 2>/dev/null && log_info "Gateway container started" || true
    fi
    
    # Wait for services to be ready
    sleep 5
    log_info "Services started"
}

# Health check
health_check() {
    if [ "$SKIP_VALIDATION" = true ]; then
        log_info "Skipping health check (--skip-validation)"
        return
    fi
    
    log_step "Running health checks..."
    
    local gateway_url="${MYTHOS_GATEWAY_URL:-http://localhost:18789}"
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would run health checks"
        return
    fi
    
    # Check gateway health
    local health_response=$(curl -s "${gateway_url}/health" 2>/dev/null || echo "")
    
    if [ -z "$health_response" ]; then
        log_error "Gateway health check failed"
        log_info "You may need to start services manually"
        return
    fi
    
    # Parse health response
    if echo "$health_response" | jq -e '.status == "healthy"' &> /dev/null; then
        log_info "Gateway health check passed"
    else
        log_warn "Gateway health check returned unexpected response"
        echo "$health_response" | jq . 2>/dev/null || echo "$health_response"
    fi
    
    # Check memory status
    if command -v openclaw &> /dev/null; then
        log_info "Checking memory status..."
        openclaw memory status 2>&1 | tee -a "$RECOVERY_LOG" || log_warn "Memory status check failed"
    fi
}

# Show recovery summary
show_summary() {
    log_step "Recovery Summary:"
    
    echo "" | tee -a "$RECOVERY_LOG"
    echo "===========================================" | tee -a "$RECOVERY_LOG"
    echo "Disaster Recovery Completed" | tee -a "$RECOVERY_LOG"
    echo "===========================================" | tee -a "$RECOVERY_LOG"
    echo "Backup File: $BACKUP_FILE" | tee -a "$RECOVERY_LOG"
    echo "Recovery Time: $(date)" | tee -a "$RECOVERY_LOG"
    echo "Recovery Log: $RECOVERY_LOG" | tee -a "$RECOVERY_LOG"
    echo "" | tee -a "$RECOVERY_LOG"
    echo "Next Steps:" | tee -a "$RECOVERY_LOG"
    echo "  1. Review the recovery log: $RECOVERY_LOG" | tee -a "$RECOVERY_LOG"
    echo "  2. Verify all services are running" | tee -a "$RECOVERY_LOG"
    echo "  3. Test critical functionality" | tee -a "$RECOVERY_LOG"
    echo "  4. Update monitoring systems" | tee -a "$RECOVERY_LOG"
    echo "  5. Notify stakeholders of recovery" | tee -a "$RECOVERY_LOG"
    echo "===========================================" | tee -a "$RECOVERY_LOG"
}

# Cleanup
cleanup() {
    log_step "Cleaning up temporary files..."
    
    if [ "$DRY_RUN" = false ]; then
        rm -rf "$RESTORE_TEMP"
        log_info "Temporary files cleaned up"
    fi
}

# Main
main() {
    log_critical "Starting Mythos Disaster Recovery..."
    log_info "Backup file: $BACKUP_FILE"
    log_info "OpenClaw home: $OPENCLAW_HOME"
    log_info "Recovery log: $RECOVERY_LOG"
    echo "" | tee -a "$RECOVERY_LOG"
    
    if [ "$DRY_RUN" = true ]; then
        log_warn "DRY RUN MODE - No changes will be made"
        echo "" | tee -a "$RECOVERY_LOG"
    fi
    
    check_prerequisites
    validate_backup
    confirm_recovery
    stop_all_services
    create_safety_backup
    extract_backup
    restore_memory
    restore_configuration
    restore_agents
    rebuild_indexes
    validate_system
    start_services
    health_check
    show_summary
    cleanup
    
    log_info "Disaster recovery completed successfully!"
}

# Handle errors
trap 'log_error "Disaster recovery failed at line $LINENO"; cleanup' ERR

# Run main
main "$@"
