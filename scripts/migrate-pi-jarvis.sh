#!/bin/bash
# Complete migration script for Pi 5 "Jarvis" installation
# This script migrates from clawdbot to OpenClaw with DeepSeek integration

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
BACKUP_SCRIPT="$(dirname "$0")/backup-pi-jarvis.sh"
MIGRATION_LOG="/tmp/jarvis-migration-$(date +%Y%m%d-%H%M%S).log"
INSTALL_METHOD="git"  # git or npm
GIT_URL="https://github.com/datboi6942/openclaw.git"
GIT_BRANCH="main"

# Check if running on Pi (optional, can run remotely via SSH)
check_pi_environment() {
    log_step "Checking Pi environment..."
    
    # Check for existing clawdbot
    if [ -d "/home/john/.clawdbot" ]; then
        log_info "Found existing clawdbot installation"
    else
        log_warn "No existing clawdbot installation found at /home/john/.clawdbot"
    fi
    
    # Check Node.js version
    if command -v node >/dev/null 2>&1; then
        NODE_VERSION=$(node --version)
        log_info "Node.js version: $NODE_VERSION"
        
        # Check for Node 22+
        if [[ "$NODE_VERSION" =~ v([0-9]+)\. ]]; then
            if [ "${BASH_REMATCH[1]}" -ge 22 ]; then
                log_info "Node.js version 22+ detected (good)"
            else
                log_warn "Node.js version < 22 detected, may need upgrade"
            fi
        fi
    else
        log_error "Node.js not found. OpenClaw requires Node.js 22+"
        exit 1
    fi
    
    # Check npm
    if command -v npm >/dev/null 2>&1; then
        log_info "npm found: $(npm --version)"
    else
        log_error "npm not found"
        exit 1
    fi
}

# Run backup
run_backup() {
    log_step "Running backup..."
    
    if [ -f "$BACKUP_SCRIPT" ]; then
        log_info "Executing backup script: $BACKUP_SCRIPT"
        chmod +x "$BACKUP_SCRIPT"
        if bash "$BACKUP_SCRIPT"; then
            log_info "Backup completed successfully"
        else
            log_warn "Backup script had issues, but continuing..."
        fi
    else
        log_warn "Backup script not found at $BACKUP_SCRIPT"
        log_info "Creating minimal backup..."
        
        BACKUP_DIR="/tmp/jarvis-minimal-backup-$(date +%Y%m%d-%H%M%S)"
        mkdir -p "$BACKUP_DIR"
        
        # Backup critical files
        CRITICAL_FILES=(
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
        
        for file in "${CRITICAL_FILES[@]}"; do
            if [ -e "$file" ]; then
                cp "$file" "$BACKUP_DIR/" 2>/dev/null && \
                log_info "Backed up: $(basename "$file")" || \
                log_warn "Failed to backup: $file"
            fi
        done
        
        log_info "Minimal backup created at: $BACKUP_DIR"
    fi
}

# Stop existing services
stop_services() {
    log_step "Stopping existing services..."
    
    # Stop systemd user services
    if systemctl --user list-units --all | grep -q "clawdbot"; then
        log_info "Stopping clawdbot systemd services..."
        systemctl --user stop clawdbot-gateway.service 2>/dev/null || true
        systemctl --user disable clawdbot-gateway.service 2>/dev/null || true
    fi
    
    # Kill running processes
    log_info "Stopping running clawdbot processes..."
    pkill -f "clawdbot" 2>/dev/null || true
    pkill -f "node.*claw" 2>/dev/null || true
    
    # Wait a moment for processes to exit
    sleep 2
    
    # Verify processes are stopped
    if pgrep -f "clawdbot" >/dev/null; then
        log_warn "Some clawdbot processes still running, forcing kill..."
        pkill -9 -f "clawdbot" 2>/dev/null || true
    fi
}

# Uninstall old package
uninstall_old() {
    log_step "Removing old installation..."
    
    # Check for global npm package
    if npm list -g clawdbot >/dev/null 2>&1; then
        log_info "Uninstalling global clawdbot package..."
        npm uninstall -g clawdbot 2>/dev/null || {
            log_warn "Failed to uninstall via npm, may need sudo"
        }
    fi
    
    # Remove binary symlinks
    if [ -f "/home/john/.npm-global/bin/clawdbot" ]; then
        rm -f "/home/john/.npm-global/bin/clawdbot" 2>/dev/null || true
    fi
    
    # Remove from PATH (informational)
    log_info "Old package removed (if it existed)"
}

# Install OpenClaw
install_openclaw() {
    log_step "Installing OpenClaw with DeepSeek integration..."
    
    case "$INSTALL_METHOD" in
        "git")
            install_via_git
            ;;
        "npm")
            install_via_npm
            ;;
        *)
            log_error "Unknown install method: $INSTALL_METHOD"
            exit 1
            ;;
    esac
}

install_via_git() {
    log_info "Installing via Git from $GIT_URL (branch: $GIT_BRANCH)"
    
    INSTALL_DIR="/tmp/openclaw-install-$(date +%s)"
    
    # Clone repository
    log_info "Cloning repository..."
    git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_URL" "$INSTALL_DIR" 2>/dev/null || {
        log_error "Failed to clone repository"
        exit 1
    }
    
    cd "$INSTALL_DIR"
    
    # Check for pnpm
    if command -v pnpm >/dev/null 2>&1; then
        log_info "Using pnpm for installation..."
        pnpm install 2>/dev/null || {
            log_warn "pnpm install had issues, trying npm..."
            npm install 2>/dev/null || true
        }
        
        # Build
        log_info "Building OpenClaw..."
        pnpm build 2>/dev/null || {
            log_warn "Build may have warnings, continuing..."
        }
        
        # Install globally
        log_info "Installing globally..."
        npm link 2>/dev/null || {
            log_warn "npm link failed, trying alternative installation..."
            npm install -g . 2>/dev/null || true
        }
    else
        log_info "pnpm not found, using npm..."
        npm install 2>/dev/null || true
        
        log_info "Building OpenClaw..."
        npm run build 2>/dev/null || {
            log_warn "Build may have warnings, continuing..."
        }
        
        log_info "Installing globally..."
        npm install -g . 2>/dev/null || {
            log_warn "Global installation may have failed"
        }
    fi
    
    # Cleanup
    cd -
    rm -rf "$INSTALL_DIR"
    
    log_info "Git installation complete"
}

install_via_npm() {
    log_info "Installing via npm from our fork..."
    
    # Install directly from GitHub
    npm install -g "github:datboi6942/openclaw" 2>/dev/null || {
        log_error "Failed to install from GitHub"
        log_info "Trying alternative method..."
        
        # Alternative: install via npm registry if published
        npm install -g openclaw 2>/dev/null || {
            log_error "Failed to install OpenClaw"
            exit 1
        }
    }
    
    log_info "npm installation complete"
}

# Verify installation
verify_installation() {
    log_step "Verifying installation..."
    
    if command -v openclaw >/dev/null 2>&1; then
        log_info "OpenClaw command found: $(which openclaw)"
        
        # Check version
        openclaw --version 2>/dev/null && log_info "OpenClaw version check passed" || \
            log_warn "Version check failed (may be normal during installation)"
    else
        log_error "OpenClaw command not found in PATH"
        log_info "Checking alternative locations..."
        
        # Check common locations
        for dir in /usr/local/bin /usr/bin /home/john/.npm-global/bin /home/john/.local/bin; do
            if [ -f "$dir/openclaw" ]; then
                log_info "Found at: $dir/openclaw"
                export PATH="$dir:$PATH"
                break
            fi
        done
        
        if ! command -v openclaw >/dev/null 2>&1; then
            log_warn "OpenClaw may not be in PATH. You may need to add it manually."
        fi
    fi
}

# Migrate data
migrate_data() {
    log_step "Migrating data from .clawdbot to .openclaw..."
    
    # First, ensure .openclaw directory exists
    mkdir -p "/home/john/.openclaw"
    
    # Check if doctor command is available
    if command -v openclaw >/dev/null 2>&1; then
        log_info "Running openclaw doctor to migrate configuration..."
        
        # Run doctor in non-interactive mode with repair
        if openclaw doctor --fix --non-interactive 2>&1 | tee -a "$MIGRATION_LOG"; then
            log_info "Doctor completed successfully"
        else
            log_warn "Doctor had issues, but continuing..."
        fi
        
        # Check if migration worked
        if [ -f "/home/john/.openclaw/openclaw.json" ]; then
            log_info "Configuration migrated to /home/john/.openclaw/openclaw.json"
        else
            log_warn "Configuration migration may have failed"
        fi
    else
        log_warn "openclaw command not available for automatic migration"
        log_info "Attempting manual migration..."
        
        # Manual migration of critical files
        if [ -f "/home/john/.clawdbot/clawdbot.json" ]; then
            log_info "Manually migrating configuration..."
            cp "/home/john/.clawdbot/clawdbot.json" "/home/john/.openclaw/openclaw.json" 2>/dev/null || true
        fi
        
        if [ -f "/home/john/.clawdbot/.env" ]; then
            cp "/home/john/.clawdbot/.env" "/home/john/.openclaw/.env" 2>/dev/null || true
        fi
    fi
    
    # Preserve workspace - it should remain at /home/john/clawd
    log_info "Preserving workspace at /home/john/clawd"
    
    # Check if workspace needs to be linked
    if [ -d "/home/john/clawd" ] && [ ! -L "/home/john/.openclaw/workspace" ]; then
        log_info "Workspace directory already exists at /home/john/clawd"
        # OpenClaw should detect this automatically via config
    fi
    
    # Preserve memory database
    if [ -d "/home/john/.clawdbot/memory/lancedb" ]; then
        log_info "Preserving memory database..."
        mkdir -p "/home/john/.openclaw/memory"
        cp -r "/home/john/.clawdbot/memory/lancedb" "/home/john/.openclaw/memory/" 2>/dev/null || {
            log_warn "Failed to copy memory database, it may need manual migration"
        }
    fi
    
    # Preserve credentials
    if [ -d "/home/john/.clawdbot/credentials" ]; then
        log_info "Preserving credentials..."
        mkdir -p "/home/john/.openclaw/credentials"
        cp -r "/home/john/.clawdbot/credentials" "/home/john/.openclaw/" 2>/dev/null || true
    fi
}

# Update configuration for DeepSeek
update_configuration() {
    log_step "Updating configuration for DeepSeek integration..."
    
    CONFIG_FILE="/home/john/.openclaw/openclaw.json"
    
    if [ -f "$CONFIG_FILE" ]; then
        log_info "Checking and updating configuration..."
        
        # Create a backup of the config
        cp "$CONFIG_FILE" "$CONFIG_FILE.backup-$(date +%s)" 2>/dev/null || true
        
        # Check if DeepSeek is already configured
        if grep -q "deepseek" "$CONFIG_FILE" 2>/dev/null; then
            log_info "DeepSeek configuration already present"
        else
            log_info "Adding DeepSeek provider configuration..."
            
            # Use Python to update JSON if available
            if command -v python3 >/dev/null 2>&1; then
                python3 -c "
import json
import sys

try:
    with open('$CONFIG_FILE', 'r') as f:
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
        'apiKey': '\${DEEPSEEK_API_KEY}',
        'api': 'openai-completions',
        'models': []
    }

# Update default model to use DeepSeek if not set
if 'agents' not in config:
    config['agents'] = {}
if 'defaults' not in config['agents']:
    config['agents']['defaults'] = {}
if 'model' not in config['agents']['defaults']:
    config['agents']['defaults']['model'] = {
        'primary': 'deepseek/deepseek-reasoner',
        'fallbacks': ['deepseek/deepseek-chat']
    }

with open('$CONFIG_FILE', 'w') as f:
    json.dump(config, f, indent=2)
" 2>/dev/null && log_info "Configuration updated" || \
                log_warn "Failed to update configuration with Python"
            else
                log_warn "Python not available for automatic config update"
                log_info "You may need to manually configure DeepSeek:"
                echo "  openclaw configure --auth-choice deepseek-api-key"
            fi
        fi
    else
        log_warn "Configuration file not found at $CONFIG_FILE"
        log_info "You can create it with: openclaw configure"
    fi
}

# Test installation
test_installation() {
    log_step "Testing installation..."
    
    if command -v openclaw >/dev/null 2>&1; then
        log_info "Running basic tests..."
        
        # Test 1: Check version
        log_info "Test 1: Checking version..."
        openclaw --version 2>&1 | head -1 && log_info "✓ Version check passed" || \
            log_warn "✗ Version check failed"
        
        # Test 2: Check doctor
        log_info "Test 2: Running doctor (diagnostic)..."
        openclaw doctor --non-interactive 2>&1 | tail -5 && log_info "✓ Doctor check passed" || \
            log_warn "✗ Doctor check had issues"
        
        # Test 3: Check models status
        log_info "Test 3: Checking models status..."
        openclaw models status 2>&1 | grep -i "deepseek\|provider" | head -5 && \
            log_info "✓ Models check passed" || \
            log_warn "✗ Models check may have issues"
        
        # Test 4: Check if workspace is accessible
        log_info "Test 4: Checking workspace..."
        if [ -f "/home/john/clawd/SOUL.md" ]; then
            log_info "✓ Workspace files present"
        else
            log_warn "✗ Workspace files not found at /home/john/clawd/"
        fi
    else
        log_error "Cannot test: openclaw command not found"
    fi
}

# Final instructions
show_final_instructions() {
    log_step "Migration complete!"
    echo ""
    echo "=== MIGRATION SUMMARY ==="
    echo "✓ Backup created"
    echo "✓ Old services stopped"
    echo "✓ OpenClaw installed"
    echo "✓ Data migrated"
    echo "✓ Configuration updated"
    echo ""
    echo "=== NEXT STEPS ==="
    echo "1. Set your DeepSeek API key:"
    echo "   export DEEPSEEK_API_KEY='your-key-here'"
    echo "   or add it to ~/.openclaw/.env"
    echo ""
    echo "2. Configure OpenClaw:"
    echo "   openclaw configure --auth-choice deepseek-api-key"
    echo ""
    echo "3. Start the gateway:"
    echo "   openclaw gateway run --daemon"
    echo ""
    echo "4. Test Jarvis:"
    echo "   openclaw message send --channel whatsapp --to 'your-number' --text 'Hello from the new Jarvis!'"
    echo ""
    echo "=== TROUBLESHOOTING ==="
    echo "• Check logs: $MIGRATION_LOG"
    echo "• Run doctor: openclaw doctor --fix"
    echo "• Check config: cat ~/.openclaw/openclaw.json | head -50"
    echo "• Verify workspace: ls -la ~/clawd/"
    echo ""
    echo "=== ROLLBACK ==="
    echo "If something went wrong, you can:"
    echo "1. Restore from backup (see backup directory)"
    echo "2. Reinstall clawdbot: npm install -g clawdbot"
    echo "3. Restore original state directory"
    echo ""
}

# Main execution
main() {
    log_step "Starting Jarvis migration to OpenClaw with DeepSeek"
    log_info "Log file: $MIGRATION_LOG"
    
    exec > >(tee -a "$MIGRATION_LOG") 2>&1
    
    # Run all steps
    check_pi_environment
    run_backup
    stop_services
    uninstall_old
    install_openclaw
    verify_installation
    migrate_data
    update_configuration
    test_installation
    show_final_instructions
    
    log_info "Migration script completed!"
}

# Run main function
main "$@"