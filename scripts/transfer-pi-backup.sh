#!/bin/bash
# Transfer backup from Pi to tower PC
# Run this on tower PC after Pi backup is complete

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

# Configuration
PI_USER="john"
PI_HOST="raspberrypi.local"
PI_BACKUP_DIR="/tmp/jarvis-minimal-backup-*"
LOCAL_BACKUP_DIR="/tmp/pi-backup-$(date +%Y%m%d-%H%M%S)"
SSH_OPTIONS="-o ConnectTimeout=10 -o BatchMode=yes"

# Check SSH connectivity
check_ssh() {
    log_step "Checking SSH connectivity to Pi..."
    
    if ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "echo 'SSH connection successful'" 2>/dev/null; then
        log_info "✓ SSH connection to Pi successful"
        return 0
    else
        log_warn "✗ SSH connection failed"
        
        # Try alternative hostnames/IPs
        local alt_hosts=("raspberrypi" "raspberrypi.local" "192.168.1.100" "192.168.1.101")
        for host in "${alt_hosts[@]}"; do
            log_info "Trying $host..."
            if ssh $SSH_OPTIONS "${PI_USER}@${host}" "echo 'SSH to $host successful'" 2>/dev/null; then
                PI_HOST="$host"
                log_info "✓ Connected to Pi at $PI_HOST"
                return 0
            fi
        done
        
        log_error "Cannot connect to Pi via SSH"
        log_info "Possible reasons:"
        log_info "1. Pi is offline or hung (needs reboot)"
        log_info "2. SSH keys not set up"
        log_info "3. Different hostname/IP"
        log_info "4. Pi backup process still running (hung)"
        echo ""
        return 1
    fi
}

# Reboot Pi if needed
reboot_pi_if_needed() {
    log_step "Checking Pi status..."
    
    # Check if Pi is responsive
    if ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "date" 2>/dev/null; then
        log_info "Pi is responsive"
        return 0
    fi
    
    log_warn "Pi is unresponsive"
    read -p "Attempt to reboot Pi? (y/N): " choice
    if [[ ! "$choice" =~ ^[Yy]$ ]]; then
        log_info "Skipping reboot"
        return 1
    fi
    
    log_info "Rebooting Pi..."
    
    # Try to reboot via sudo (if passwordless sudo)
    if ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "sudo reboot" 2>/dev/null; then
        log_info "Reboot command sent"
        log_info "Waiting 60 seconds for Pi to restart..."
        sleep 60
    else
        log_warn "Could not reboot via SSH"
        log_info "You may need to physically power cycle the Pi"
        read -p "Continue without Pi reboot? (y/N): " choice2
        if [[ ! "$choice2" =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Run minimal backup on Pi
run_pi_backup() {
    log_step "Running minimal backup on Pi..."
    
    # Check if backup script exists on Pi
    if ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "test -f ~/openclaw/scripts/backup-pi-minimal.sh" 2>/dev/null; then
        log_info "Found backup script on Pi"
        
        # Run backup script
        log_info "Executing backup script..."
        ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "cd ~/openclaw && bash scripts/backup-pi-minimal.sh" 2>/dev/null
        
        # Find the backup directory
        PI_BACKUP_DIR=$(ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "ls -td /tmp/jarvis-minimal-backup-* 2>/dev/null | head -1" 2>/dev/null)
        
        if [ -n "$PI_BACKUP_DIR" ]; then
            log_info "Backup created on Pi: $PI_BACKUP_DIR"
            return 0
        else
            log_warn "Could not find backup directory on Pi"
            return 1
        fi
    else
        log_warn "Backup script not found on Pi"
        log_info "Creating manual backup..."
        
        # Create manual backup directory
        local manual_backup="/tmp/jarvis-manual-backup-$(date +%Y%m%d-%H%M%S)"
        ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "mkdir -p $manual_backup" 2>/dev/null
        
        # Backup critical files
        local critical_files=(
            "/home/john/.clawdbot/clawdbot.json"
            "/home/john/.clawdbot/.env"
            "/home/john/clawd/SOUL.md"
            "/home/john/clawd/AGENTS.md"
            "/home/john/clawd/TOOLS.md"
            "/home/john/clawd/IDENTITY.md"
            "/home/john/clawd/USER.md"
            "/home/john/clawd/HEARTBEAT.md"
            "/home/john/clawd/MEMORY.md"
        )
        
        for file in "${critical_files[@]}"; do
            ssh $SSH_OPTIONS "${PI_USER}@${PI_HOST}" "cp $file $manual_backup/ 2>/dev/null || true" 2>/dev/null
        done
        
        PI_BACKUP_DIR="$manual_backup"
        log_info "Manual backup created: $PI_BACKUP_DIR"
        return 0
    fi
}

# Transfer backup from Pi to tower
transfer_backup() {
    local pi_backup_dir="$1"
    
    log_step "Transferring backup from Pi..."
    
    if [ -z "$pi_backup_dir" ]; then
        log_error "No backup directory specified"
        return 1
    fi
    
    # Create local backup directory
    mkdir -p "$LOCAL_BACKUP_DIR"
    
    # Use rsync if available
    if command -v rsync >/dev/null 2>&1; then
        log_info "Using rsync to transfer files..."
        rsync -avz -e "ssh $SSH_OPTIONS" "${PI_USER}@${PI_HOST}:${pi_backup_dir}/" "$LOCAL_BACKUP_DIR/" 2>/dev/null
    else
        log_info "Using scp to transfer files..."
        scp -r $SSH_OPTIONS "${PI_USER}@${PI_HOST}:${pi_backup_dir}/*" "$LOCAL_BACKUP_DIR/" 2>/dev/null
    fi
    
    # Check if files were transferred
    if [ "$(ls -A "$LOCAL_BACKUP_DIR" 2>/dev/null | wc -l)" -gt 0 ]; then
        log_info "✓ Backup transferred to: $LOCAL_BACKUP_DIR"
        ls -la "$LOCAL_BACKUP_DIR/"
        return 0
    else
        log_warn "No files transferred"
        return 1
    fi
}

# Check for existing backups on tower
check_existing_backups() {
    log_step "Checking for existing backups on tower..."
    
    local existing_backups=()
    for backup in /tmp/pi-backup-* /tmp/jarvis-backup-* /tmp/jarvis-minimal-backup-*; do
        if [ -d "$backup" ]; then
            existing_backups+=("$backup")
        fi
    done
    
    if [ ${#existing_backups[@]} -gt 0 ]; then
        log_info "Found ${#existing_backups[@]} existing backup(s):"
        for backup in "${existing_backups[@]}"; do
            log_info "  - $backup"
        done
        
        read -p "Use existing backup instead of transferring? (y/N): " choice
        if [[ "$choice" =~ ^[Yy]$ ]]; then
            LOCAL_BACKUP_DIR="${existing_backups[0]}"
            log_info "Using existing backup: $LOCAL_BACKUP_DIR"
            return 0  # Skip transfer
        fi
    fi
    
    return 1  # Proceed with transfer
}

# Main execution
main() {
    log_step "Starting Pi backup transfer to tower PC"
    
    # Check for existing backups first
    if check_existing_backups; then
        log_info "Using existing backup, skipping transfer"
        echo ""
        echo "=== NEXT STEPS ==="
        echo "Run migration with existing backup:"
        echo "  ./scripts/migrate-tower-jarvis.sh --backup \"$LOCAL_BACKUP_DIR\""
        echo ""
        exit 0
    fi
    
    # Check SSH connectivity
    if ! check_ssh; then
        log_warn "Cannot connect to Pi"
        log_info "You may need to:"
        log_info "1. Physically reboot the Pi"
        log_info "2. Check network connectivity"
        log_info "3. Update PI_HOST in this script"
        echo ""
        read -p "Continue with manual backup transfer? (y/N): " choice
        if [[ ! "$choice" =~ ^[Yy]$ ]]; then
            exit 1
        fi
        
        # Manual transfer instructions
        echo ""
        echo "=== MANUAL TRANSFER INSTRUCTIONS ==="
        echo "1. Reboot Pi (power cycle)"
        echo "2. SSH into Pi: ssh john@raspberrypi.local"
        echo "3. Run backup: cd openclaw && bash scripts/backup-pi-minimal.sh"
        echo "4. Note backup location (e.g., /tmp/jarvis-minimal-backup-*)"
        echo "5. Copy files to tower:"
        echo "   scp -r john@raspberrypi.local:/tmp/jarvis-minimal-backup-* /tmp/"
        echo "6. Run migration with backup:"
        echo "   ./scripts/migrate-tower-jarvis.sh --backup /tmp/jarvis-minimal-backup-*"
        echo ""
        exit 0
    fi
    
    # Reboot Pi if needed
    reboot_pi_if_needed
    
    # Run backup on Pi
    if ! run_pi_backup; then
        log_error "Failed to create backup on Pi"
        exit 1
    fi
    
    # Transfer backup
    if ! transfer_backup "$PI_BACKUP_DIR"; then
        log_error "Failed to transfer backup"
        exit 1
    fi
    
    # Success
    log_step "Transfer complete!"
    echo ""
    echo "=== TRANSFER SUMMARY ==="
    echo "✓ Pi backup created: $PI_BACKUP_DIR"
    echo "✓ Files transferred to tower: $LOCAL_BACKUP_DIR"
    echo ""
    echo "=== NEXT STEPS ==="
    echo "1. Verify backup contents:"
    echo "   ls -la \"$LOCAL_BACKUP_DIR/\""
    echo ""
    echo "2. Run migration:"
    echo "   ./scripts/migrate-tower-jarvis.sh --backup \"$LOCAL_BACKUP_DIR\""
    echo ""
    echo "3. If you have a DeepSeek API key, include it:"
    echo "   ./scripts/migrate-tower-jarvis.sh --backup \"$LOCAL_BACKUP_DIR\" --deepseek-key \"your-key\""
    echo ""
}

# Run main function
main "$@"