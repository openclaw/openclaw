#!/bin/bash
# Minimal backup script for Pi 5 "Jarvis" installation
# Only backs up critical files, avoids copying entire directories
# Safe to run when system resources are limited

set -euo pipefail

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

# Configuration
BACKUP_DIR="/tmp/jarvis-minimal-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
LOG_FILE="$BACKUP_DIR/backup.log"

exec > >(tee -a "$LOG_FILE") 2>&1

log_info "Starting minimal backup of Jarvis installation"
log_info "Backup directory: $BACKUP_DIR"

# Function to safely copy file
safe_copy() {
    local src="$1"
    local dst="$2"
    local description="$3"
    
    if [ -e "$src" ]; then
        log_info "Backing up $description: $(basename "$src")"
        # Use cp with timeout to avoid hanging
        timeout 10 cp "$src" "$dst" 2>/dev/null && \
            log_info "✓ $(basename "$src")" || \
            log_warn "⚠ Failed to copy $(basename "$src")"
    else
        log_warn "Not found: $(basename "$src")"
    fi
}

# Function to safely archive directory
safe_archive() {
    local src="$1"
    local dst="$2"
    local description="$3"
    
    if [ -d "$src" ]; then
        log_info "Archiving $description: $(basename "$src")"
        # Use tar with timeout and limit
        timeout 30 tar -czf "$dst.tar.gz" -C "$(dirname "$src")" "$(basename "$src")" --exclude="*.log" --exclude="*.tmp" 2>/dev/null && \
            log_info "✓ $(basename "$src") (archived)" || \
            log_warn "⚠ Failed to archive $(basename "$src")"
    else
        log_warn "Directory not found: $(basename "$src")"
    fi
}

# ============================================
# CRITICAL FILES ONLY
# ============================================

log_info "=== Backing up critical files ==="

# 1. Configuration files
safe_copy "/home/john/.clawdbot/clawdbot.json" "$BACKUP_DIR/clawdbot.json" "Main configuration"
safe_copy "/home/john/.clawdbot/.env" "$BACKUP_DIR/.env" "Environment file"

# 2. Workspace files (Jarvis personality)
WORKSPACE_FILES=(
    "SOUL.md"
    "AGENTS.md" 
    "TOOLS.md"
    "IDENTITY.md"
    "USER.md"
    "HEARTBEAT.md"
    "MEMORY.md"
)

for file in "${WORKSPACE_FILES[@]}"; do
    safe_copy "/home/john/clawd/$file" "$BACKUP_DIR/$file" "Workspace file"
done

# 3. Memory database (critical for Jarvis memories)
if [ -d "/home/john/.clawdbot/memory/lancedb" ]; then
    log_info "Backing up memory database..."
    # Try to copy just the lance files, not entire directory
    find "/home/john/.clawdbot/memory/lancedb" -name "*.lance" -type f 2>/dev/null | head -5 | while read -r lance_file; do
        dst_file="$BACKUP_DIR/memory-$(basename "$lance_file")"
        timeout 15 cp "$lance_file" "$dst_file" 2>/dev/null && \
            log_info "✓ Memory file: $(basename "$lance_file")" || \
            log_warn "⚠ Failed memory file: $(basename "$lance_file")"
    done
    
    # If no lance files found, try to archive the directory
    if [ ! -f "$BACKUP_DIR"/*.lance 2>/dev/null ]; then
        safe_archive "/home/john/.clawdbot/memory/lancedb" "$BACKUP_DIR/memory-db" "Memory database"
    fi
fi

# 4. Check existing backup from yesterday
YESTERDAY_BACKUP="/home/john/.clawdbot/backup-20260203-195638"
if [ -d "$YESTERDAY_BACKUP" ]; then
    log_info "Found yesterday's backup at: $YESTERDAY_BACKUP"
    # Create reference file
    echo "Yesterday's backup exists at: $YESTERDAY_BACKUP" > "$BACKUP_DIR/yesterday-backup-reference.txt"
    ls -la "$YESTERDAY_BACKUP/" > "$BACKUP_DIR/yesterday-backup-listing.txt" 2>/dev/null || true
fi

# ============================================
# VERIFICATION
# ============================================

log_info "=== Verifying backup ==="

VERIFICATION_FILE="$BACKUP_DIR/verification.txt"

{
    echo "=== Minimal Backup Verification ==="
    echo "Generated: $(date)"
    echo "Backup location: $BACKUP_DIR"
    echo ""
    echo "=== Files backed up ==="
    ls -la "$BACKUP_DIR/" 2>/dev/null || echo "Cannot list directory"
    echo ""
    echo "=== Critical file check ==="
    
    critical_count=0
    for file in clawdbot.json .env SOUL.md AGENTS.md; do
        if [ -f "$BACKUP_DIR/$file" ]; then
            echo "✓ $file"
            critical_count=$((critical_count + 1))
        else
            echo "✗ $file"
        fi
    done
    
    echo ""
    echo "Critical files backed up: $critical_count/4"
    echo ""
    
    # Check memory files
    if ls "$BACKUP_DIR"/memory-*.lance 1>/dev/null 2>&1 || [ -f "$BACKUP_DIR/memory-db.tar.gz" ]; then
        echo "✓ Memory database backed up"
    else
        echo "✗ Memory database missing"
    fi
    
} > "$VERIFICATION_FILE"

log_info "Verification report: $VERIFICATION_FILE"

# ============================================
# FINAL SUMMARY
# ============================================

log_info "=== Backup complete ==="
log_info "Backup location: $BACKUP_DIR"
log_info "Log file: $LOG_FILE"
log_info "Verification: $VERIFICATION_FILE"

echo ""
echo "=== NEXT STEPS ==="
echo "1. Check verification: cat $VERIFICATION_FILE"
echo "2. If critical files are missing, check log: tail -20 $LOG_FILE"
echo "3. Proceed with migration when ready"
echo ""
echo "To restore quickly:"
echo "  cp $BACKUP_DIR/clawdbot.json /home/john/.clawdbot/"
echo "  cp $BACKUP_DIR/.env /home/john/.clawdbot/"
echo "  cp $BACKUP_DIR/*.md /home/john/clawd/"