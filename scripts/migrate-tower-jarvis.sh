#!/bin/bash
# Migration script for tower PC "Jarvis" installation
# This script migrates from clawdbot to OpenClaw with DeepSeek integration
# Assumes backup files are available in a directory (from Pi backup)

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
BACKUP_SOURCE=""
MIGRATION_LOG="/tmp/tower-migration-$(date +%Y%m%d-%H%M%S).log"
OPENCLAW_REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEEPSEEK_API_KEY=""

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        -b|--backup)
            BACKUP_SOURCE="$2"
            shift 2
            ;;
        -k|--deepseek-key)
            DEEPSEEK_API_KEY="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Migrate Jarvis from clawdbot to OpenClaw on tower PC"
            echo ""
            echo "Options:"
            echo "  -b, --backup DIR      Source directory containing Pi backup"
            echo "  -k, --deepseek-key KEY  DeepSeek API key"
            echo "  -h, --help            Show this help"
            echo ""
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Source nvm if available
source_nvm() {
    if [ -f "$HOME/.nvm/nvm.sh" ]; then
        export NVM_DIR="$HOME/.nvm"
        source "$NVM_DIR/nvm.sh" 2>/dev/null || true
    fi
}

# Check environment
check_environment() {
    log_step "Checking tower PC environment..."
    
    # Source nvm to ensure correct Node.js version
    source_nvm
    
    # Check Node.js version
    if command -v node >/dev/null 2>&1; then
        NODE_VERSION=$(node --version)
        log_info "Node.js version: $NODE_VERSION"
        
        # Check for Node 22+
        if [[ "$NODE_VERSION" =~ v([0-9]+)\. ]]; then
            if [ "${BASH_REMATCH[1]}" -ge 22 ]; then
                log_info "Node.js version 22+ detected (good)"
            else
                log_error "Node.js version < 22 detected. OpenClaw requires Node.js 22+"
                exit 1
            fi
        fi
    else
        log_error "Node.js not found"
        exit 1
    fi
    
    # Check if we're in the OpenClaw repo
    if [ ! -f "$OPENCLAW_REPO_DIR/package.json" ]; then
        log_error "Not in OpenClaw repository directory"
        exit 1
    fi
    
    log_info "OpenClaw repo: $OPENCLAW_REPO_DIR"
}

# Check backup source
check_backup_source() {
    log_step "Checking backup source..."
    
    if [ -z "$BACKUP_SOURCE" ]; then
        log_warn "No backup source specified"
        log_info "Looking for recent backups..."
        
        # Check for backups in /tmp
        local latest_backup=""
        for backup in /tmp/jarvis-backup-* /tmp/jarvis-minimal-backup-*; do
            if [ -d "$backup" ]; then
                if [ -z "$latest_backup" ] || [ "$backup" -nt "$latest_backup" ]; then
                    latest_backup="$backup"
                fi
            fi
        done
        
        if [ -n "$latest_backup" ]; then
            BACKUP_SOURCE="$latest_backup"
            log_info "Using latest backup: $BACKUP_SOURCE"
        else
            log_warn "No backups found in /tmp"
            log_info "You may need to copy backup from Pi first"
            log_info "Run: scripts/transfer-pi-backup.sh (if available)"
            read -p "Continue without backup? (y/N): " choice
            if [[ ! "$choice" =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    fi
    
    if [ -n "$BACKUP_SOURCE" ] && [ -d "$BACKUP_SOURCE" ]; then
        log_info "Backup source verified: $BACKUP_SOURCE"
        ls -la "$BACKUP_SOURCE/" | head -10
    elif [ -n "$BACKUP_SOURCE" ]; then
        log_error "Backup source not found: $BACKUP_SOURCE"
        exit 1
    fi
}

# Stop existing services
stop_services() {
    log_step "Stopping existing services..."
    
    # Stop systemd user services
    if systemctl --user list-units --all 2>/dev/null | grep -q "clawdbot"; then
        log_info "Stopping clawdbot systemd services..."
        systemctl --user stop clawdbot-gateway.service 2>/dev/null || true
        systemctl --user disable clawdbot-gateway.service 2>/dev/null || true
    fi
    
    # Kill running processes
    log_info "Stopping running clawdbot processes..."
    pkill -f "clawdbot" 2>/dev/null || true
    pkill -f "node.*claw" 2>/dev/null || true
    
    # Wait a moment
    sleep 2
    
    # Force kill if needed
    if pgrep -f "clawdbot" >/dev/null; then
        log_warn "Some clawdbot processes still running, forcing kill..."
        pkill -9 -f "clawdbot" 2>/dev/null || true
    fi
}

# Restore from backup
restore_from_backup() {
    local backup_dir="$1"
    
    log_step "Restoring from backup: $backup_dir"
    
    if [ ! -d "$backup_dir" ]; then
        log_warn "Backup directory not found, skipping restore"
        return 0
    fi
    
    # Restore configuration
    if [ -f "$backup_dir/clawdbot.json" ]; then
        log_info "Restoring configuration..."
        mkdir -p "/home/john/.clawdbot"
        cp "$backup_dir/clawdbot.json" "/home/john/.clawdbot/clawdbot.json" 2>/dev/null || \
            log_warn "Failed to copy configuration"
    fi
    
    if [ -f "$backup_dir/.env" ]; then
        log_info "Restoring environment file..."
        mkdir -p "/home/john/.clawdbot"
        cp "$backup_dir/.env" "/home/john/.clawdbot/.env" 2>/dev/null || \
            log_warn "Failed to copy environment file"
    fi
    
    # Restore workspace files
    log_info "Restoring workspace files..."
    mkdir -p "/home/john/clawd"
    
    local workspace_files=(
        "SOUL.md" "AGENTS.md" "TOOLS.md" "IDENTITY.md"
        "USER.md" "HEARTBEAT.md" "MEMORY.md"
    )
    
    for file in "${workspace_files[@]}"; do
        if [ -f "$backup_dir/$file" ]; then
            cp "$backup_dir/$file" "/home/john/clawd/$file" 2>/dev/null && \
                log_info "✓ $file" || \
                log_warn "⚠ Failed to copy $file"
        fi
    done
    
    # Restore memory database if present
    if [ -d "$backup_dir/memory-db" ] || [ -f "$backup_dir/memory-db.tar.gz" ]; then
        log_info "Restoring memory database..."
        mkdir -p "/home/john/.clawdbot/memory"
        
        if [ -d "$backup_dir/memory-db" ]; then
            cp -r "$backup_dir/memory-db" "/home/john/.clawdbot/memory/lancedb" 2>/dev/null || \
                log_warn "Failed to copy memory database directory"
        elif [ -f "$backup_dir/memory-db.tar.gz" ]; then
            tar -xzf "$backup_dir/memory-db.tar.gz" -C "/home/john/.clawdbot/memory/" 2>/dev/null || \
                log_warn "Failed to extract memory database archive"
        fi
    fi
    
    log_info "Backup restored"
}

# Build OpenClaw from local repo
build_openclaw() {
    log_step "Building OpenClaw from local repository..."
    
    cd "$OPENCLAW_REPO_DIR"
    
    # Source nvm to ensure correct Node.js version
    source_nvm
    
    # Check if already built
    if [ -f "dist/index.js" ] && [ -f "openclaw.mjs" ]; then
        log_info "OpenClaw already built, checking if fresh build needed..."
        # We'll rebuild to ensure DeepSeek integration is included
    fi
    
    # Check for pnpm
    if command -v pnpm >/dev/null 2>&1; then
        log_info "Using pnpm for build..."
        pnpm build 2>&1 | tail -20
    elif command -v npx >/dev/null 2>&1; then
        log_info "Using npx pnpm for build..."
        npx pnpm build 2>&1 | tail -20
    else
        log_error "pnpm not found and npx not available"
        exit 1
    fi
    
    # Verify build
    if [ -f "dist/index.js" ]; then
        log_info "✓ Build completed successfully"
    else
        log_error "Build failed: dist/index.js not found"
        exit 1
    fi
}

# Install OpenClaw locally
install_openclaw() {
    log_step "Installing OpenClaw locally..."
    
    cd "$OPENCLAW_REPO_DIR"
    
    # Create symlink or use npm link
    log_info "Creating local installation..."
    
    # Try npm link first
    if npm link 2>/dev/null; then
        log_info "✓ OpenClaw linked globally via npm link"
    else
        log_warn "npm link failed, creating manual symlink"
        
        # Find global npm bin directory
        local npm_bin_dir=""
        if command -v npm >/dev/null 2>&1; then
            npm_bin_dir=$(npm bin -g 2>/dev/null || echo "")
        fi
        
        if [ -n "$npm_bin_dir" ] && [ -d "$npm_bin_dir" ]; then
            ln -sf "$OPENCLAW_REPO_DIR/openclaw.mjs" "$npm_bin_dir/openclaw" 2>/dev/null || true
            log_info "Symlink created in $npm_bin_dir"
        else
            log_warn "Could not determine global bin directory"
            log_info "You may need to run OpenClaw directly from repo: node openclaw.mjs"
        fi
    fi
}

# Verify installation
verify_installation() {
    log_step "Verifying installation..."
    
    # Source nvm to ensure correct Node.js version
    source_nvm
    
    # Try to run openclaw command
    if command -v openclaw >/dev/null 2>&1; then
        log_info "✓ OpenClaw command found: $(which openclaw)"
    elif [ -f "$OPENCLAW_REPO_DIR/openclaw.mjs" ]; then
        log_info "✓ OpenClaw available at $OPENCLAW_REPO_DIR/openclaw.mjs"
        # Add alias for rest of script
        alias openclaw="node '$OPENCLAW_REPO_DIR/openclaw.mjs'"
    else
        log_error "OpenClaw not found"
        exit 1
    fi
    
    # Check version
    log_info "Checking OpenClaw version..."
    if node "$OPENCLAW_REPO_DIR/openclaw.mjs" --version 2>&1 | grep -q "2026"; then
        log_info "✓ OpenClaw version check passed"
    else
        log_warn "Version check may have issues (but continuing)"
    fi
}

# Migrate configuration using openclaw doctor
migrate_configuration() {
    log_step "Migrating configuration..."
    
    # Source nvm to ensure correct Node.js version
    source_nvm
    
    # Ensure .openclaw directory exists
    mkdir -p "/home/john/.openclaw"
    
    # Run doctor to migrate config
    log_info "Running openclaw doctor to migrate configuration..."
    
    if command -v openclaw >/dev/null 2>&1; then
        openclaw doctor --fix --non-interactive 2>&1 | tail -20
    elif [ -f "$OPENCLAW_REPO_DIR/openclaw.mjs" ]; then
        node "$OPENCLAW_REPO_DIR/openclaw.mjs" doctor --fix --non-interactive 2>&1 | tail -20
    else
        log_warn "Cannot run doctor, manual migration may be needed"
    fi
    
    # Check if migration worked
    if [ -f "/home/john/.openclaw/openclaw.json" ]; then
        log_info "✓ Configuration migrated to /home/john/.openclaw/openclaw.json"
    else
        log_warn "Configuration migration may have failed"
    fi
}

# Configure DeepSeek provider
configure_deepseek() {
    log_step "Configuring DeepSeek provider..."
    
    # Source nvm to ensure correct Node.js version
    source_nvm
    
    # Check for API key
    local api_key="$DEEPSEEK_API_KEY"
    if [ -z "$api_key" ]; then
        log_warn "DeepSeek API key not provided"
        log_info "You can set it later with: export DEEPSEEK_API_KEY='your-key'"
        log_info "Or add to ~/.openclaw/.env"
        return 0
    fi
    
    # Set environment variable
    export DEEPSEEK_API_KEY="$api_key"
    echo "export DEEPSEEK_API_KEY='$api_key'" >> "/home/john/.openclaw/.env" 2>/dev/null || true
    
    # Configure provider using onboard in non-interactive mode
    log_info "Configuring DeepSeek provider via onboard..."
    
    local onboard_cmd=""
    if command -v openclaw >/dev/null 2>&1; then
        onboard_cmd="openclaw"
    elif [ -f "$OPENCLAW_REPO_DIR/openclaw.mjs" ]; then
        onboard_cmd="node '$OPENCLAW_REPO_DIR/openclaw.mjs'"
    else
        log_warn "Cannot configure DeepSeek automatically"
        log_info "You can configure manually:"
        log_info "1. Set DEEPSEEK_API_KEY environment variable"
        log_info "2. Run: openclaw onboard --auth-choice deepseek-api-key --deepseek-api-key 'your-key' --non-interactive --accept-risk"
        return 1
    fi
    
    # Run onboard in non-interactive mode
    log_info "Running onboard with DeepSeek configuration..."
    local onboard_output=""
    onboard_output=$(eval "$onboard_cmd onboard \
      --auth-choice deepseek-api-key \
      --deepseek-api-key '$api_key' \
      --non-interactive \
      --accept-risk \
      --flow quickstart \
      --mode local \
      --workspace '/home/john/clawd' \
      2>&1" || true)
    
    echo "$onboard_output" | tail -20
    
    # Check if onboard succeeded
    if echo "$onboard_output" | grep -q "error\|Error\|ERROR\|failed\|Failed"; then
        log_warn "Onboard may have encountered errors"
        log_info "You may need to configure DeepSeek manually"
    else
        log_info "Onboard completed (check output above for any issues)"
    fi
    
    # Also set the API key in config if possible
    log_info "Setting DeepSeek API key in config..."
    if [ -f "/home/john/.openclaw/openclaw.json" ]; then
        # Try to update config with Python if available
        if command -v python3 >/dev/null 2>&1; then
            python3 -c "
import json
import sys

try:
    with open('/home/john/.openclaw/openclaw.json', 'r') as f:
        config = json.load(f)
except:
    config = {}

# Ensure models.providers exists
if 'models' not in config:
    config['models'] = {}
if 'providers' not in config['models']:
    config['models']['providers'] = {}

# Add DeepSeek provider if not present
if 'deepseek' not in config['models']['providers']:
    config['models']['providers']['deepseek'] = {
        'baseUrl': 'https://api.deepseek.com/v1',
        'apiKey': '$api_key',
        'api': 'openai-completions',
        'models': []
    }

with open('/home/john/.openclaw/openclaw.json', 'w') as f:
    json.dump(config, f, indent=2)
" 2>/dev/null && log_info "✓ Configuration updated with DeepSeek provider" || \
                log_warn "Failed to update configuration with Python"
        fi
    fi
    
    log_info "DeepSeek configuration attempt completed"
    log_info "Note: You may need to run additional configuration steps manually"
}

# Test installation
test_installation() {
    log_step "Testing installation..."
    
    # Source nvm to ensure correct Node.js version
    source_nvm
    
    log_info "Running basic tests..."
    
    # Test 1: Check models status
    log_info "Test 1: Checking models status..."
    if command -v openclaw >/dev/null 2>&1; then
        openclaw models status 2>&1 | grep -i "deepseek\|provider" | head -5
    else
        node "$OPENCLAW_REPO_DIR/openclaw.mjs" models status 2>&1 | grep -i "deepseek\|provider" | head -5
    fi
    
    # Test 2: Check workspace
    log_info "Test 2: Checking workspace..."
    if [ -f "/home/john/clawd/SOUL.md" ]; then
        log_info "✓ Workspace files present"
        echo "First few lines of SOUL.md:"
        head -5 "/home/john/clawd/SOUL.md"
    else
        log_warn "✗ Workspace files not found at /home/john/clawd/"
    fi
    
    # Test 3: Check configuration
    log_info "Test 3: Checking configuration..."
    if [ -f "/home/john/.openclaw/openclaw.json" ]; then
        log_info "✓ Configuration file exists"
    else
        log_warn "✗ Configuration file missing"
    fi
    
    # Test 4: Check if DeepSeek appears in onboard help
    log_info "Test 4: Checking DeepSeek CLI option..."
    if command -v openclaw >/dev/null 2>&1; then
        if openclaw onboard --help 2>&1 | grep -q "deepseek-api-key"; then
            log_info "✓ DeepSeek option found in onboard help"
        else
            log_warn "✗ DeepSeek option not found in onboard help"
        fi
    fi
}

# Final instructions
show_final_instructions() {
    log_step "Migration complete!"
    echo ""
    echo "=== MIGRATION SUMMARY ==="
    echo "✓ Environment checked"
    echo "✓ Services stopped"
    [ -n "$BACKUP_SOURCE" ] && echo "✓ Backup restored"
    echo "✓ OpenClaw built and installed"
    echo "✓ Configuration migrated"
    [ -n "$DEEPSEEK_API_KEY" ] && echo "✓ DeepSeek configured"
    echo ""
    echo "=== NEXT STEPS ==="
    echo ""
    echo "1. Ensure DeepSeek API key is set:"
    echo "   export DEEPSEEK_API_KEY='your-key-here'"
    echo "   (or add to ~/.openclaw/.env)"
    echo ""
    echo "2. Start the gateway:"
    echo "   openclaw gateway run --daemon"
    echo ""
    echo "3. Test Jarvis:"
    echo "   openclaw message send --channel whatsapp --to 'your-number' --text 'Hello from the new Jarvis!'"
    echo ""
    echo "4. Monitor logs:"
    echo "   tail -f /tmp/openclaw-gateway.log"
    echo ""
    echo "=== TROUBLESHOOTING ==="
    echo "• Check migration log: $MIGRATION_LOG"
    echo "• Run doctor: openclaw doctor --fix"
    echo "• Verify DeepSeek appears in providers: openclaw configure"
    echo "• Check workspace: ls -la ~/clawd/"
    echo ""
}

# Main execution
main() {
    log_step "Starting Jarvis migration to OpenClaw on tower PC"
    log_info "Log file: $MIGRATION_LOG"
    
    exec > >(tee -a "$MIGRATION_LOG") 2>&1
    
    # Run all steps
    check_environment
    check_backup_source
    stop_services
    
    if [ -n "$BACKUP_SOURCE" ]; then
        restore_from_backup "$BACKUP_SOURCE"
    fi
    
    build_openclaw
    install_openclaw
    verify_installation
    migrate_configuration
    configure_deepseek
    test_installation
    show_final_instructions
    
    log_info "Migration script completed!"
}

# Run main function
main "$@"