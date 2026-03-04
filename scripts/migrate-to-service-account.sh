#!/bin/bash
#
# migrate-to-service-account.sh
# Migrates OpenClaw from running as your admin user to a dedicated
# 'openclaw' service account with restricted permissions.
#
# This improves security by ensuring the AI process:
# - Cannot modify system files or install software
# - Cannot self-approve secret grants (grants dir owned by human)
# - Runs with minimal privileges
#
# Supports: macOS (launchd) and Linux (systemd)
#
# Usage: sudo bash scripts/migrate-to-service-account.sh
#
# Rollback: sudo bash scripts/rollback-service-account.sh
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# Detect platform
OS=$(uname -s)
CURRENT_USER="${SUDO_USER:-$(whoami)}"
OPENCLAW_USER="openclaw"
OPENCLAW_HOME="/opt/openclaw"
OPENCLAW_DATA="$OPENCLAW_HOME/.openclaw"
OPENCLAW_PROJECTS="$OPENCLAW_HOME/projects"

# Detect current OpenClaw location
if [ -d "$HOME/.openclaw" ]; then
  OLD_DATA="$HOME/.openclaw"
elif [ -d "/Users/$CURRENT_USER/.openclaw" ]; then
  OLD_DATA="/Users/$CURRENT_USER/.openclaw"
elif [ -d "/home/$CURRENT_USER/.openclaw" ]; then
  OLD_DATA="/home/$CURRENT_USER/.openclaw"
else
  err "Cannot find existing OpenClaw data directory. Is OpenClaw installed?"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  OpenClaw Service Account Migration              ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "Platform:       $OS"
info "Current user:   $CURRENT_USER"
info "Source:         $OLD_DATA"
info "Destination:    $OPENCLAW_DATA"
echo ""

# Confirm
read -p "Proceed with migration? (y/N) " -n 1 -r
echo
[[ $REPLY =~ ^[Yy]$ ]] || exit 0

# Check root
if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run with sudo"
fi

# ─── Step 1: Stop OpenClaw ───────────────────────────
echo ""
log "Step 1: Stopping OpenClaw..."

if [ "$OS" = "Darwin" ]; then
  # macOS: stop LaunchAgent or LaunchDaemon
  launchctl bootout "gui/$(id -u "$CURRENT_USER")" \
    "/Users/$CURRENT_USER/Library/LaunchAgents/ai.openclaw.gateway.plist" 2>/dev/null || true
  launchctl bootout system /Library/LaunchDaemons/ai.openclaw.gateway.plist 2>/dev/null || true
else
  # Linux: stop systemd user service
  sudo -u "$CURRENT_USER" systemctl --user stop openclaw-gateway.service 2>/dev/null || true
  systemctl stop openclaw-gateway.service 2>/dev/null || true
fi

# Also kill any running process
pkill -f "openclaw.*gateway" 2>/dev/null || true
sleep 1
log "OpenClaw stopped"

# ─── Step 2: Create service account ─────────────────
echo ""
log "Step 2: Creating service account '$OPENCLAW_USER'..."

if id "$OPENCLAW_USER" &>/dev/null; then
  warn "User '$OPENCLAW_USER' already exists, skipping creation"
else
  if [ "$OS" = "Darwin" ]; then
    # macOS: create system user
    # Find available UID in system range (400-499)
    for uid in $(seq 400 499); do
      if ! dscl . -list /Users UniqueID | awk '{print $2}' | grep -q "^${uid}$"; then
        break
      fi
    done
    
    dscl . -create "/Users/$OPENCLAW_USER"
    dscl . -create "/Users/$OPENCLAW_USER" UserShell /usr/bin/false
    dscl . -create "/Users/$OPENCLAW_USER" NFSHomeDirectory "$OPENCLAW_HOME"
    dscl . -create "/Users/$OPENCLAW_USER" UniqueID "$uid"
    dscl . -create "/Users/$OPENCLAW_USER" PrimaryGroupID 20  # staff group
    dscl . -create "/Users/$OPENCLAW_USER" RealName "OpenClaw Service"
    # Hide from login screen
    dscl . -create "/Users/$OPENCLAW_USER" IsHidden 1
    log "Created macOS system user (UID: $uid)"
  else
    # Linux: create system user
    useradd --system --shell /usr/bin/false --home-dir "$OPENCLAW_HOME" \
      --create-home --comment "OpenClaw Service" "$OPENCLAW_USER"
    log "Created Linux system user"
  fi
fi

# ─── Step 3: Create directory structure ──────────────
echo ""
log "Step 3: Setting up directories..."

mkdir -p "$OPENCLAW_HOME"
mkdir -p "$OPENCLAW_DATA"
mkdir -p "$OPENCLAW_PROJECTS"
mkdir -p "$OPENCLAW_DATA/logs"
mkdir -p "$OPENCLAW_DATA/grants"

log "Directory structure created"

# ─── Step 4: Copy data ──────────────────────────────
echo ""
log "Step 4: Copying OpenClaw data..."

# Backup first
BACKUP_DIR="$OLD_DATA/migration-backup-$(date +%Y%m%d%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -R "$OLD_DATA/workspace" "$BACKUP_DIR/" 2>/dev/null || true
cp "$OLD_DATA/openclaw.json" "$BACKUP_DIR/" 2>/dev/null || true
log "Backup created at $BACKUP_DIR"

# Copy data
cp -R "$OLD_DATA/"* "$OPENCLAW_DATA/" 2>/dev/null || true
log "Data copied to $OPENCLAW_DATA"

# ─── Step 5: Set permissions ────────────────────────
echo ""
log "Step 5: Setting permissions..."

# OpenClaw owns its home
chown -R "$OPENCLAW_USER:staff" "$OPENCLAW_HOME"

# CRITICAL: Grants dir owned by human user
# This prevents the AI from self-approving secret access
chown "$CURRENT_USER:staff" "$OPENCLAW_DATA/grants"
chmod 755 "$OPENCLAW_DATA/grants"

# State dir accessible but not world-readable
chmod 711 "$OPENCLAW_DATA"

# Config readable by openclaw but not writable
if [ -f "$OPENCLAW_DATA/openclaw.json" ]; then
  chown "$CURRENT_USER:staff" "$OPENCLAW_DATA/openclaw.json"
  chmod 640 "$OPENCLAW_DATA/openclaw.json"
  # Add openclaw to staff group read
  if [ "$OS" = "Darwin" ]; then
    dseditgroup -o edit -a "$OPENCLAW_USER" -t user staff 2>/dev/null || true
  fi
fi

log "Permissions set (grants dir owned by $CURRENT_USER)"

# ─── Step 6: Create symlinks ────────────────────────
echo ""
log "Step 6: Creating symlinks for human user access..."

# Symlink so human user can still access workspace
if [ "$OS" = "Darwin" ]; then
  HUMAN_HOME="/Users/$CURRENT_USER"
else
  HUMAN_HOME="/home/$CURRENT_USER"
fi

if [ -L "$HUMAN_HOME/.openclaw" ]; then
  rm "$HUMAN_HOME/.openclaw"
elif [ -d "$HUMAN_HOME/.openclaw" ] && [ "$HUMAN_HOME/.openclaw" != "$OLD_DATA" ]; then
  warn "Unexpected .openclaw directory, skipping symlink"
fi

ln -sf "$OPENCLAW_DATA" "$HUMAN_HOME/.openclaw" 2>/dev/null || true
log "Symlinked $HUMAN_HOME/.openclaw → $OPENCLAW_DATA"

# ─── Step 7: Install service ────────────────────────
echo ""
log "Step 7: Installing system service..."

# Detect node path
NODE_PATH=$(which node 2>/dev/null || echo "/opt/homebrew/bin/node")
OPENCLAW_PATH=$(which openclaw 2>/dev/null)
if [ -z "$OPENCLAW_PATH" ]; then
  OPENCLAW_PATH=$(npm root -g 2>/dev/null)/openclaw/openclaw.mjs
fi

if [ "$OS" = "Darwin" ]; then
  # macOS LaunchDaemon
  PLIST="/Library/LaunchDaemons/ai.openclaw.gateway.plist"
  
  cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openclaw.gateway</string>
  <key>UserName</key><string>$OPENCLAW_USER</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$OPENCLAW_PATH</string>
    <string>gateway</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$OPENCLAW_HOME</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$OPENCLAW_HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>$OPENCLAW_DATA/logs/gateway.log</string>
  <key>StandardErrorPath</key><string>$OPENCLAW_DATA/logs/gateway.log</string>
</dict>
</plist>
EOF
  
  chmod 644 "$PLIST"
  
  # Disable old LaunchAgent if exists
  OLD_PLIST="/Users/$CURRENT_USER/Library/LaunchAgents/ai.openclaw.gateway.plist"
  if [ -f "$OLD_PLIST" ]; then
    launchctl bootout "gui/$(id -u "$CURRENT_USER")" "$OLD_PLIST" 2>/dev/null || true
    mv "$OLD_PLIST" "$OLD_PLIST.disabled"
    warn "Old LaunchAgent disabled: $OLD_PLIST.disabled"
  fi
  
  log "LaunchDaemon created at $PLIST"
  
else
  # Linux systemd
  SERVICE="/etc/systemd/system/openclaw-gateway.service"
  
  cat > "$SERVICE" << EOF
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=$OPENCLAW_USER
WorkingDirectory=$OPENCLAW_HOME
Environment=HOME=$OPENCLAW_HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_PATH $OPENCLAW_PATH gateway start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  
  systemctl daemon-reload
  systemctl enable openclaw-gateway.service
  
  # Disable old user service
  sudo -u "$CURRENT_USER" systemctl --user disable openclaw-gateway.service 2>/dev/null || true
  
  log "Systemd service created at $SERVICE"
fi

# ─── Step 8: Start service ──────────────────────────
echo ""
log "Step 8: Starting OpenClaw..."

if [ "$OS" = "Darwin" ]; then
  launchctl bootstrap system "$PLIST"
else
  systemctl start openclaw-gateway.service
fi

sleep 2

# Verify
if pgrep -f "openclaw.*gateway" > /dev/null; then
  log "OpenClaw is running as '$OPENCLAW_USER'"
else
  warn "OpenClaw may not have started. Check logs: $OPENCLAW_DATA/logs/gateway.log"
fi

# ─── Summary ────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Migration Complete                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "Service account:  $OPENCLAW_USER"
info "Home directory:   $OPENCLAW_HOME"
info "Data directory:   $OPENCLAW_DATA"
info "Grants (human):   $OPENCLAW_DATA/grants  (owned by $CURRENT_USER)"
info "Logs:             $OPENCLAW_DATA/logs/gateway.log"
info "Backup:           $BACKUP_DIR"
echo ""
info "Your workspace is still accessible via symlink:"
info "  $HUMAN_HOME/.openclaw → $OPENCLAW_DATA"
echo ""
info "To manage:"
if [ "$OS" = "Darwin" ]; then
  info "  Start:   sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.gateway.plist"
  info "  Stop:    sudo launchctl bootout system /Library/LaunchDaemons/ai.openclaw.gateway.plist"
else
  info "  Start:   sudo systemctl start openclaw-gateway"
  info "  Stop:    sudo systemctl stop openclaw-gateway"
  info "  Status:  sudo systemctl status openclaw-gateway"
fi
echo ""
warn "Rollback: sudo bash $OPENCLAW_HOME/.openclaw/workspace/scripts/rollback-service-account.sh"
