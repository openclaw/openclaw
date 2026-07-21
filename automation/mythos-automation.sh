#!/bin/bash
# Mythos Master Automation Script
# Orchestrates all automation tasks

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-/var/log/mythos-automation}"
LOG_FILE="${LOG_DIR}/master_$(date +%Y%m%d_%H%M%S).log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

show_usage() {
    cat <<EOF
Mythos Master Automation Script

Usage: $0 <command> [options]

Commands:
    backup              Run automated backup
    restore <file>      Restore from backup
    rotate-tokens       Rotate security tokens
    health-check        Run comprehensive health check
    scale <command>     Scaling operations (status|up|down|auto|monitor|recommend)
    disaster-recovery   Run disaster recovery procedure
    full-maintenance    Run full maintenance routine

Options:
    --log-dir <dir>     Log directory (default: /var/log/mythos-automation)
    --help, -h          Show this help message

Examples:
    $0 backup
    $0 restore /backup/mythos_20250120.tar.gz
    $0 rotate-tokens --all
    $0 health-check --alert
    $0 scale status
    $0 scale up 5
    $0 full-maintenance

Environment Variables:
    LOG_DIR             Log directory (default: /var/log/mythos-automation)

EOF
}

# Ensure log directory exists
setup_logging() {
    mkdir -p "$LOG_DIR"
    echo "========================================" >> "$LOG_FILE"
    echo "Mythos Master Automation Log" >> "$LOG_FILE"
    echo "Started: $(date)" >> "$LOG_FILE"
    echo "========================================" >> "$LOG_FILE"
}

# Run backup
run_backup() {
    log_step "Running automated backup..."
    
    if [ ! -x "$SCRIPT_DIR/backup.sh" ]; then
        log_error "backup.sh not found or not executable"
        return 1
    fi
    
    "$SCRIPT_DIR/backup.sh" "$@" 2>&1 | tee -a "$LOG_FILE"
    local exit_code=${PIPESTATUS[0]}
    
    if [ $exit_code -eq 0 ]; then
        log_info "Backup completed successfully"
    else
        log_error "Backup failed with exit code $exit_code"
    fi
    
    return $exit_code
}

# Run restore
run_restore() {
    local backup_file="$1"
    shift
    
    if [ -z "$backup_file" ]; then
        log_error "Backup file not specified"
        return 1
    fi
    
    log_step "Running restore from $backup_file..."
    
    if [ ! -x "$SCRIPT_DIR/restore.sh" ]; then
        log_error "restore.sh not found or not executable"
        return 1
    fi
    
    "$SCRIPT_DIR/restore.sh" "$backup_file" "$@" 2>&1 | tee -a "$LOG_FILE"
    local exit_code=${PIPESTATUS[0]}
    
    if [ $exit_code -eq 0 ]; then
        log_info "Restore completed successfully"
    else
        log_error "Restore failed with exit code $exit_code"
    fi
    
    return $exit_code
}

# Run token rotation
run_rotate_tokens() {
    log_step "Running token rotation..."
    
    if [ ! -x "$SCRIPT_DIR/rotate-tokens.sh" ]; then
        log_error "rotate-tokens.sh not found or not executable"
        return 1
    fi
    
    "$SCRIPT_DIR/rotate-tokens.sh" "$@" 2>&1 | tee -a "$LOG_FILE"
    local exit_code=${PIPESTATUS[0]}
    
    if [ $exit_code -eq 0 ]; then
        log_info "Token rotation completed successfully"
    else
        log_error "Token rotation failed with exit code $exit_code"
    fi
    
    return $exit_code
}

# Run health check
run_health_check() {
    log_step "Running health check..."
    
    if [ ! -x "$SCRIPT_DIR/health-check.sh" ]; then
        log_error "health-check.sh not found or not executable"
        return 1
    fi
    
    "$SCRIPT_DIR/health-check.sh" "$@" 2>&1 | tee -a "$LOG_FILE"
    local exit_code=${PIPESTATUS[0]}
    
    if [ $exit_code -eq 0 ]; then
        log_info "Health check completed successfully"
    else
        log_error "Health check failed with exit code $exit_code"
    fi
    
    return $exit_code
}

# Run scaling operation
run_scale() {
    local scale_command="$1"
    shift
    
    if [ -z "$scale_command" ]; then
        log_error "Scale command not specified"
        return 1
    fi
    
    log_step "Running scale operation: $scale_command..."
    
    if [ ! -x "$SCRIPT_DIR/scale.sh" ]; then
        log_error "scale.sh not found or not executable"
        return 1
    fi
    
    "$SCRIPT_DIR/scale.sh" "$scale_command" "$@" 2>&1 | tee -a "$LOG_FILE"
    local exit_code=${PIPESTATUS[0]}
    
    if [ $exit_code -eq 0 ]; then
        log_info "Scale operation completed successfully"
    else
        log_error "Scale operation failed with exit code $exit_code"
    fi
    
    return $exit_code
}

# Run disaster recovery
run_disaster_recovery() {
    local backup_file="$1"
    shift
    
    if [ -z "$backup_file" ]; then
        log_error "Backup file not specified for disaster recovery"
        return 1
    fi
    
    log_step "Running disaster recovery from $backup_file..."
    
    if [ ! -x "$SCRIPT_DIR/disaster-recovery.sh" ]; then
        log_error "disaster-recovery.sh not found or not executable"
        return 1
    fi
    
    "$SCRIPT_DIR/disaster-recovery.sh" "$backup_file" "$@" 2>&1 | tee -a "$LOG_FILE"
    local exit_code=${PIPESTATUS[0]}
    
    if [ $exit_code -eq 0 ]; then
        log_info "Disaster recovery completed successfully"
    else
        log_error "Disaster recovery failed with exit code $exit_code"
    fi
    
    return $exit_code
}

# Run full maintenance
run_full_maintenance() {
    log_step "Running full maintenance routine..."
    
    local exit_code=0
    
    # 1. Health check
    log_info "Step 1/5: Running health check..."
    run_health_check --quiet || exit_code=1
    
    # 2. Backup
    log_info "Step 2/5: Running backup..."
    run_backup || exit_code=1
    
    # 3. Token rotation (if needed)
    log_info "Step 3/5: Checking token rotation..."
    # Only rotate if tokens are older than 30 days
    local token_age_file="$OPENCLAW_HOME/.token_age"
    if [ -f "$token_age_file" ]; then
        local last_rotation=$(cat "$token_age_file")
        local now=$(date +%s)
        local age_days=$(( (now - last_rotation) / 86400 ))
        
        if [ "$age_days" -ge 30 ]; then
            log_info "Tokens are $age_days days old, rotating..."
            run_rotate_tokens --all || exit_code=1
            echo "$now" > "$token_age_file"
        else
            log_info "Tokens are $age_days days old, rotation not needed"
        fi
    else
        log_info "No token age file found, skipping rotation"
    fi
    
    # 4. Scale check
    log_info "Step 4/5: Checking scaling status..."
    run_scale recommend || exit_code=1
    
    # 5. Final health check
    log_info "Step 5/5: Running final health check..."
    run_health_check || exit_code=1
    
    if [ $exit_code -eq 0 ]; then
        log_info "Full maintenance completed successfully"
    else
        log_error "Full maintenance completed with errors"
    fi
    
    return $exit_code
}

# Main execution
main() {
    if [ $# -eq 0 ]; then
        show_usage
        exit 1
    fi
    
    local command="$1"
    shift
    
    # Handle global options
    while [[ $# -gt 0 ]]; do
        case $1 in
            --log-dir)
                LOG_DIR="$2"
                shift 2
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                # Pass to subcommand
                break
                ;;
        esac
    done
    
    setup_logging
    
    log_info "Mythos Master Automation started"
    log_info "Command: $command"
    log_info "Arguments: $@"
    
    local exit_code=0
    
    case "$command" in
        backup)
            run_backup "$@" || exit_code=1
            ;;
        
        restore)
            run_restore "$@" || exit_code=1
            ;;
        
        rotate-tokens)
            run_rotate_tokens "$@" || exit_code=1
            ;;
        
        health-check)
            run_health_check "$@" || exit_code=1
            ;;
        
        scale)
            run_scale "$@" || exit_code=1
            ;;
        
        disaster-recovery)
            run_disaster_recovery "$@" || exit_code=1
            ;;
        
        full-maintenance)
            run_full_maintenance || exit_code=1
            ;;
        
        --help|-h)
            show_usage
            exit 0
            ;;
        
        *)
            log_error "Unknown command: $command"
            show_usage
            exit 1
            ;;
    esac
    
    log_info "Mythos Master Automation completed"
    log_info "Log file: $LOG_FILE"
    
    exit $exit_code
}

# Run main
main "$@"
