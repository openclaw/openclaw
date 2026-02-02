#!/bin/bash
set -e

# OpenClaw Message Queue - Ubuntu Setup Script

echo "🦞 OpenClaw Queue System - Ubuntu Setup"
echo "============================================"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
  echo "❌ Please run this script as root"
  exit 1
fi

# Configuration
OPENCLAW_DIR=${OPENCLAW_DIR:-/opt/openclaw}
OPENCLAW_USER=${OPENCLAW_USER:-openclaw}
REDIS_PASSWORD=${REDIS_PASSWORD:-$(openssl rand -base64 32)}
QUEUE_ENABLED=${QUEUE_ENABLED:-true}
WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-5}

echo ""
echo "Configuration:"
echo "  OpenClaw directory: $OPENCLAW_DIR"
echo "  OpenClaw user: $OPENCLAW_USER"
echo "  Redis password: [generated and saved]"
echo "  Queue enabled: $QUEUE_ENABLED"
echo "  Worker concurrency: $WORKER_CONCURRENCY"
echo ""

# Step 1: Update system packages
echo "📦 Step 1: Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# Step 2: Install dependencies
echo "📦 Step 2: Installing dependencies..."

# Node.js 22.x
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1) -lt 22 ]]; then
  echo "  Installing Node.js 22.x..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "  ✓ Node.js $(node -v) already installed"
fi

# Redis
if ! command -v redis-server &> /dev/null; then
  echo "  Installing Redis..."
  apt-get install -y redis-server
else
  echo "  ✓ Redis already installed"
fi

# Git
if ! command -v git &> /dev/null; then
  echo "  Installing Git..."
  apt-get install -y git
else
  echo "  ✓ Git already installed"
fi

# Build tools
apt-get install -y build-essential

# Step 3: Create OpenClaw user
echo ""
echo "👤 Step 3: Creating OpenClaw user..."
if ! id "$OPENCLAW_USER" &> /dev/null; then
  useradd -r -s /bin/bash -d "$OPENCLAW_DIR" "$OPENCLAW_USER"
  echo "  ✓ User '$OPENCLAW_USER' created"
else
  echo "  ✓ User '$OPENCLAW_USER' already exists"
fi

# Step 4: Setup directories
echo ""
echo "📁 Step 4: Setting up directories..."
mkdir -p "$OPENCLAW_DIR"
mkdir -p /var/log/openclaw
chown -R "$OPENCLAW_USER:$OPENCLAW_USER" "$OPENCLAW_DIR"
chown -R "$OPENCLAW_USER:$OPENCLAW_USER" /var/log/openclaw
echo "  ✓ Directories created and permissions set"

# Step 5: Setup OpenClaw
echo ""
echo "📦 Step 5: Setting up OpenClaw..."

if [[ -d "$OPENCLAW_DIR/.git" ]]; then
  echo "  Updating existing installation..."
  cd "$OPENCLAW_DIR"
  sudo -u "$OPENCLAW_USER" git fetch origin
  sudo -u "$OPENCLAW_USER" git reset --hard origin/main
else
  echo "  Please clone OpenClaw manually:"
  echo "    git clone https://github.com/openclaw/openclaw.git $OPENCLAW_DIR"
  echo "    chown -R $OPENCLAW_USER:$OPENCLAW_USER $OPENCLAW_DIR"
  echo "    cd $OPENCLAW_DIR"
  echo "    npm install"
  echo "    npm run build"
  echo ""
  echo "  Re-run this script after installation"
  exit 0
fi

# Step 6: Install dependencies and build
echo ""
echo "🔨 Step 6: Installing dependencies..."
cd "$OPENCLAW_DIR"
sudo -u "$OPENCLAW_USER" npm ci

echo ""
echo "🔨 Building OpenClaw..."
sudo -u "$OPENCLAW_USER" npm run build

# Step 7: Configure Redis
echo ""
echo "🗄️  Step 7: Configuring Redis..."

# Configure Redis with password
REDIS_CONF="/etc/redis/redis.conf"
REDIS_PASSWORD_ESC=$(printf '%s\n' "$REDIS_PASSWORD" | sed 's/[\/&]/\\&/g')

if ! grep -q "^requirepass" "$REDIS_CONF"; then
  echo "  Setting Redis password..."
  echo "requirepass $REDIS_PASSWORD_ESC" >> "$REDIS_CONF"
else
  echo "  ✓ Redis already configured with password"
fi

# Restart Redis
echo "  Restarting Redis..."
systemctl restart redis-server
echo "  ✓ Redis running"

# Step 8: Configure OpenClaw
echo ""
echo "⚙️  Step 8: Configuring OpenClaw queue..."

CONFIG_FILE="$OPENCLAW_DIR/config.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "  Creating new config..."
  sudo -u "$OPENCLAW_USER" bash -c "cat > '$CONFIG_FILE' << 'EOFCONFIG'
{
  "queue": {
    "enabled": $QUEUE_ENABLED,
    "redis": {
      "url": "redis://localhost:6379",
      "keyPrefix": "openclaw:queue",
      "password": "$REDIS_PASSWORD"
    },
    "priority": {
      "adminUsers": [],
      "ownerUserIds": [],
      "urgentKeywords": ["urgent", "asap", "emergency"]
    },
    "worker": {
      "maxConcurrency": $WORKER_CONCURRENCY,
      "pollIntervalMs": 100,
      "maxRetries": 3,
      "retryDelayMs": 5000
    },
    "webhooks": []
  }
}
EOFCONFIG"
else
  echo "  ✓ Config already exists (edit manually to enable queue)"
fi

# Step 9: Install systemd service
echo ""
echo "⚙️  Step 9: Installing systemd service..."
cp "$OPENCLAW_DIR/scripts/openclaw-worker.service" /etc/systemd/system/
systemctl daemon-reload

# Enable and start service
echo ""
echo "🚀 Step 10: Enabling and starting queue worker..."
systemctl enable openclaw-worker
systemctl start openclaw-worker

# Wait for service to start
sleep 3

# Check service status
if systemctl is-active --quiet openclaw-worker; then
  echo "  ✓ Queue worker service started successfully"
else
  echo "  ❌ Queue worker service failed to start"
  echo "  Check logs: journalctl -u openclaw-worker -n 50"
  exit 1
fi

# Save password to file
PASSWORD_FILE="$OPENCLAW_DIR/.redis-password"
echo "$REDIS_PASSWORD" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"
chown "$OPENCLAW_USER:$OPENCLAW_USER" "$PASSWORD_FILE"

# Display summary
echo ""
echo "============================================"
echo "✅ Setup Complete!"
echo ""
echo "Next steps:"
echo ""
echo "1. Check worker status:"
echo "   systemctl status openclaw-worker"
echo ""
echo "2. View worker logs:"
echo "   journalctl -u openclaw-worker -f"
echo ""
echo "3. Test queue system:"
echo "   cd $OPENCLAW_DIR && npm run queue status"
echo ""
echo "4. Edit configuration:"
echo "   nano $CONFIG_FILE"
echo ""
echo "Redis password saved to: $PASSWORD_FILE"
echo "  Keep this file secure and backed up!"
echo ""
echo "============================================"
