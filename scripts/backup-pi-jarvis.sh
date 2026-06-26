#!/bin/bash
# Comprehensive backup script for Pi 5 "Jarvis" installation
# This script backs up all critical data before migration to new OpenClaw

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

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Configuration
BACKUP_ROOT="/tmp/jarvis-backup-$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/full-backup"
QUICK_BACKUP_DIR="$BACKUP_ROOT/quick-restore"
LOG_FILE="$BACKUP_ROOT/backup.log"

# Create backup directories
mkdir -p "$BACKUP_DIR"
mkdir -p "$QUICK_BACKUP_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

log_info "Starting comprehensive backup of Jarvis installation"
log_info "Backup root: $BACKUP_ROOT"
log_info "Log file: $LOG_FILE"

# Function to backup with verification
backup_with_verify() {
    local src="$1"
    local dst="$2"
    local description="$3"
    
    if [ -e "$src" ]; then
        log_info "Backing up $description: $src"
        if [ -d "$src" ]; then
            cp -r "$src" "$dst" 2>/dev/null || {
                log_warn "Failed to copy directory $src, attempting tar..."
                tar -czf "$dst.tar.gz" -C "$(dirname "$src")" "$(basename "$src")" 2>/dev/null || true
            }
        else
            cp "$src" "$dst" 2>/dev/null || true
        fi
        
        # Verify backup
        if [ -d "$src" ] && [ -d "$dst" ] || [ -f "$src" ] && [ -f "$dst" ]; then
            log_info "✓ $description backed up successfully"
        else
            log_warn "⚠ $description backup may be incomplete"
        fi
    else
        log_warn "$description not found: $src"
    fi
}

# ============================================
# PHASE 1: CRITICAL DATA BACKUP
# ============================================

log_info "=== PHASE 1: Backing up critical data ==="

# 1. State directory (.clawdbot)
backup_with_verify "/home/john/.clawdbot" "$BACKUP_DIR/state" "State directory"

# 2. Workspace (clawd) - Contains SOUL.md, AGENTS.md, etc.
backup_with_verify "/home/john/clawd" "$BACKUP_DIR/workspace" "Workspace directory"

# 3. Memory database
backup_with_verify "/home/john/.clawdbot/memory/lancedb" "$BACKUP_DIR/memory-db" "Memory database"

# 4. Configuration files
backup_with_verify "/home/john/.clawdbot/clawdbot.json" "$BACKUP_DIR/config/clawdbot.json" "Main configuration"
backup_with_verify "/home/john/.clawdbot/.env" "$BACKUP_DIR/config/.env" "Environment file"

# 5. Credentials
backup_with_verify "/home/john/.clawdbot/credentials" "$BACKUP_DIR/credentials" "Credentials"

# 6. Agents and sessions
backup_with_verify "/home/john/.clawdbot/agents" "$BACKUP_DIR/agents" "Agents"
backup_with_verify "/home/john/.clawdbot/subagents" "$BACKUP_DIR/subagents" "Subagents"

# ============================================
# PHASE 2: PACKAGE ANALYSIS
# ============================================

log_info "=== PHASE 2: Analyzing package for hotfixes ==="

PACKAGE_DIR="/home/john/.npm-global/lib/node_modules/clawdbot"
HOTFIX_REPORT="$BACKUP_DIR/hotfix-analysis.txt"

if [ -d "$PACKAGE_DIR" ]; then
    log_info "Analyzing clawdbot package for hotfixes"
    
    # Create hotfix analysis report
    {
        echo "=== Hotfix Analysis Report ==="
        echo "Generated: $(date)"
        echo "Package directory: $PACKAGE_DIR"
        echo ""
        echo "=== Package Version ==="
        cat "$PACKAGE_DIR/package.json" | grep -i version 2>/dev/null || echo "Version not found"
        echo ""
        echo "=== DeepSeek References ==="
        find "$PACKAGE_DIR/dist" -type f -name "*.js" -o -name "*.ts" 2>/dev/null | \
            xargs grep -l -i "deepseek" 2>/dev/null | head -20
        echo ""
        echo "=== Modified Files (recent changes) ==="
        find "$PACKAGE_DIR" -type f -name "*.js" -o -name "*.ts" -o -name "*.json" 2>/dev/null | \
            xargs ls -lt 2>/dev/null | head -10
        echo ""
        echo "=== Potential Hotfix Patterns ==="
        find "$PACKAGE_DIR/dist" -type f \( -name "*.js" -o -name "*.ts" \) 2>/dev/null | \
            xargs grep -l -E "(TODO|FIXME|HACK|hotfix|temporary|workaround)" 2>/dev/null | head -10
    } > "$HOTFIX_REPORT"
    
    # Backup the actual package
    backup_with_verify "$PACKAGE_DIR" "$BACKUP_DIR/package" "Clawdbot package"
else
    log_warn "Clawdbot package not found at $PACKAGE_DIR"
fi

# ============================================
# PHASE 3: SYSTEM STATE
# ============================================

log_info "=== PHASE 3: Backing up system state ==="

# 7. Service status
{
    echo "=== System Services ==="
    systemctl --user list-units --all | grep -i clawdbot || echo "No clawdbot systemd units found"
    echo ""
    echo "=== Running Processes ==="
    ps aux | grep -E "(clawdbot|node.*claw)" | grep -v grep || echo "No clawdbot processes found"
    echo ""
    echo "=== Environment Variables ==="
    env | grep -i "OPENCLAW\|CLAWDBOT\|MOLTBOT\|DEEPSEEK\|OPENAI" || echo "No relevant env vars found"
} > "$BACKUP_DIR/system-state.txt"

# 8. Quick restore package (minimal set for recovery)
log_info "Creating quick restore package"
QUICK_FILES=(
    "/home/john/.clawdbot/clawdbot.json"
    "/home/john/.clawdbot/.env"
    "/home/john/clawd/SOUL.md"
    "/home/john/clawd/AGENTS.md"
    "/home/john/clawd/TOOLS.md"
    "/home/john/clawd/IDENTITY.md"
    "/home/john/clawd/USER.md"
    "/home/john/clawd/HEARTBEAT.md"
    "/home/john/clawd/MEMORY.md"
    "/home/john/.clawdbot/memory/lancedb"
)

for file in "${QUICK_FILES[@]}"; do
    if [ -e "$file" ]; then
        dst_name=$(basename "$file")
        if [ -d "$file" ]; then
            tar -czf "$QUICK_BACKUP_DIR/${dst_name}.tar.gz" -C "$(dirname "$file")" "$(basename "$file")" 2>/dev/null || true
        else
            cp "$file" "$QUICK_BACKUP_DIR/${dst_name}" 2>/dev/null || true
        fi
    fi
done

# ============================================
# PHASE 4: VERIFICATION
# ============================================

log_info "=== PHASE 4: Verifying backup integrity ==="

VERIFICATION_REPORT="$BACKUP_ROOT/verification.txt"

{
    echo "=== Backup Verification Report ==="
    echo "Generated: $(date)"
    echo "Backup location: $BACKUP_ROOT"
    echo ""
    echo "=== Directory Structure ==="
    find "$BACKUP_ROOT" -type f | sort
    echo ""
    echo "=== Critical Files Check ==="
    
    # Check for critical files
    critical_files=(
        "$BACKUP_DIR/state/clawdbot.json"
        "$BACKUP_DIR/workspace/SOUL.md"
        "$BACKUP_DIR/memory-db/memories.lance"
        "$BACKUP_DIR/config/.env"
    )
    
    for file in "${critical_files[@]}"; do
        if [ -e "$file" ] || [ -e "${file}.tar.gz" ]; then
            echo "✓ $(basename "$file")"
        else
            echo "✗ MISSING: $(basename "$file")"
        fi
    done
    
    echo ""
    echo "=== Backup Sizes ==="
    du -sh "$BACKUP_DIR" 2>/dev/null || echo "Cannot calculate size"
    echo ""
    echo "=== Quick Restore Contents ==="
    ls -la "$QUICK_BACKUP_DIR/" 2>/dev/null || echo "Quick restore directory empty"
    
} > "$VERIFICATION_REPORT"

# ============================================
# PHASE 5: FINAL SUMMARY
# ============================================

log_info "=== PHASE 5: Final summary ==="

log_info "Backup completed successfully!"
log_info "Backup location: $BACKUP_ROOT"
log_info "Full backup: $BACKUP_DIR"
log_info "Quick restore: $QUICK_BACKUP_DIR"
log_info "Log file: $LOG_FILE"
log_info "Verification report: $VERIFICATION_REPORT"
log_info "Hotfix analysis: $HOTFIX_REPORT"

echo ""
echo "=== NEXT STEPS ==="
echo "1. Review the verification report: cat $VERIFICATION_REPORT"
echo "2. Check for any warnings in the log: tail -20 $LOG_FILE"
echo "3. The quick restore package can be used for emergency recovery"
echo "4. Proceed with migration when ready"
echo ""
echo "To restore critical files quickly:"
echo "  tar -xzf $QUICK_BACKUP_DIR/SOUL.md.tar.gz -C /home/john/clawd/ 2>/dev/null || cp $QUICK_BACKUP_DIR/SOUL.md /home/john/clawd/ 2>/dev/null"
echo "  cp $QUICK_BACKUP_DIR/clawdbot.json /home/john/.clawdbot/ 2>/dev/null"

# Create a simple restore script
cat > "$BACKUP_ROOT/quick-restore.sh" << 'EOF'
#!/bin/bash
# Quick restore script for Jarvis critical files

set -euo pipefail

echo "=== Jarvis Quick Restore ==="
echo "Restoring critical files from backup..."

BACKUP_DIR="$(dirname "$0")/quick-restore"

if [ ! -d "$BACKUP_DIR" ]; then
    echo "Error: Quick restore directory not found!"
    exit 1
fi

# Restore workspace files
for file in SOUL.md AGENTS.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md MEMORY.md; do
    if [ -f "$BACKUP_DIR/$file" ]; then
        cp "$BACKUP_DIR/$file" "/home/john/clawd/$file"
        echo "Restored: $file"
    elif [ -f "$BACKUP_DIR/${file}.tar.gz" ]; then
        tar -xzf "$BACKUP_DIR/${file}.tar.gz" -C "/home/john/clawd/"
        echo "Restored: $file (from archive)"
    fi
done

# Restore config
if [ -f "$BACKUP_DIR/clawdbot.json" ]; then
    cp "$BACKUP_DIR/clawdbot.json" "/home/john/.clawdbot/clawdbot.json"
    echo "Restored: configuration"
fi

# Restore environment
if [ -f "$BACKUP_DIR/.env" ]; then
    cp "$BACKUP_DIR/.env" "/home/john/.clawdbot/.env"
    echo "Restored: environment file"
fi

echo "Quick restore complete!"
echo "You may need to restart services for changes to take effect."
EOF

chmod +x "$BACKUP_ROOT/quick-restore.sh"

log_info "Created quick restore script: $BACKUP_ROOT/quick-restore.sh"
log_info "Backup process complete!"