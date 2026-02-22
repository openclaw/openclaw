#!/bin/bash
# Quick setup script for OpenClaw on Raspberry Pi with AWS Bedrock
# Automates system setup, OpenClaw installation, and Bedrock configuration

set -e

echo "🍓🦞 Raspberry Pi + AWS Bedrock Quick Setup"
echo "==========================================="
echo ""
echo "This script will:"
echo "  1. Update system packages"
echo "  2. Install Node.js 22"
echo "  3. Configure swap (if needed)"
echo "  4. Install AWS CLI"
echo "  5. Install OpenClaw"
echo "  6. Configure AWS Bedrock"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# Check if running on Raspberry Pi
if ! grep -q "Raspberry Pi" /proc/cpuinfo 2>/dev/null; then
    echo "⚠️  Warning: Not running on Raspberry Pi"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ]; then
    echo "❌ Error: Requires 64-bit OS (aarch64), found: $ARCH"
    echo "   Please flash Raspberry Pi OS 64-bit"
    exit 1
fi

echo ""
echo "📦 Step 1: Updating system..."
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl build-essential unzip

echo ""
echo "📦 Step 2: Installing Node.js 22..."
if ! command -v node &> /dev/null || ! node --version | grep -q "v22"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
fi

NODE_VERSION=$(node --version)
echo "   ✅ Node.js installed: $NODE_VERSION"

echo ""
echo "💾 Step 3: Checking swap..."
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
SWAP_SIZE=$(free -m | awk '/^Swap:/{print $2}')

if [ $TOTAL_MEM -le 4096 ] && [ $SWAP_SIZE -lt 2048 ]; then
    echo "   Adding 2GB swap for memory efficiency..."

    if [ ! -f /swapfile ]; then
        sudo fallocate -l 2G /swapfile
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
        sudo swapon /swapfile

        # Make permanent
        if ! grep -q "/swapfile" /etc/fstab; then
            echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
        fi

        # Reduce swappiness
        echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
        sudo sysctl -p
    fi

    echo "   ✅ Swap configured"
else
    echo "   ✅ Swap already configured or not needed"
fi

echo ""
echo "☁️  Step 4: Installing AWS CLI..."
if ! command -v aws &> /dev/null; then
    cd /tmp
    curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
    unzip -q awscliv2.zip
    sudo ./aws/install
    rm -rf aws awscliv2.zip
    cd -
fi

AWS_VERSION=$(aws --version)
echo "   ✅ AWS CLI installed: $AWS_VERSION"

echo ""
echo "🦞 Step 5: Installing OpenClaw..."
if ! command -v openclaw &> /dev/null; then
    curl -fsSL https://openclaw.ai/install.sh | bash
    # Reload shell environment
    export PATH="$HOME/.npm-global/bin:$PATH"
fi

OPENCLAW_VERSION=$(openclaw --version)
echo "   ✅ OpenClaw installed: $OPENCLAW_VERSION"

echo ""
echo "☁️  Step 6: Configuring AWS credentials..."
echo ""
if [ -f ~/.aws/credentials ]; then
    echo "   ℹ️  AWS credentials already configured"
else
    echo "   Please enter your AWS credentials:"
    aws configure
fi

# Verify credentials
if aws sts get-caller-identity &> /dev/null; then
    echo "   ✅ AWS credentials verified"
else
    echo "   ⚠️  AWS credentials not working"
    echo "   You may need to run: aws configure"
fi

echo ""
echo "🔧 Step 7: Configuring OpenClaw for Bedrock..."

# Enable Bedrock discovery
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# Set default model
openclaw config set agents.defaults.model.primary \
    "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"

# Configure for Pi memory limits
openclaw config set agents.defaults.maxConcurrent 2
openclaw config set agents.defaults.subagents.maxConcurrent 4
openclaw config set agents.defaults.compaction.mode "safeguard"

echo "   ✅ OpenClaw configured"

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Enable model access in AWS Bedrock:"
echo "   https://console.aws.amazon.com/bedrock"
echo ""
echo "2. Run onboarding wizard:"
echo "   openclaw onboard --install-daemon"
echo ""
echo "3. Configure channels (e.g., Telegram):"
echo "   openclaw config set channels.telegram.botToken YOUR_TOKEN"
echo "   openclaw config set channels.telegram.dmPolicy open"
echo "   openclaw config set channels.telegram.allowFrom '[\"*\"]'"
echo ""
echo "4. Test Bedrock connection:"
echo "   ./scripts/troubleshooting/test-bedrock-models.sh"
echo ""
echo "5. Monitor performance:"
echo "   ./scripts/raspberry-pi-monitor.sh"
echo ""
echo "📚 Documentation:"
echo "   - Raspberry Pi: docs/platforms/raspberry-pi.md"
echo "   - AWS Bedrock: docs/providers/bedrock.md"
