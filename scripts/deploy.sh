#!/bin/bash

# 🚀 OpenClaw World Model Deployment Script
#
# Usage:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# This script:
# 1. Installs dependencies (Node.js, pnpm, PM2)
# 2. Sets up environment variables
# 3. Runs tests
# 4. Starts agent with PM2
# 5. Shows next steps (Telegram setup, etc.)

set -e

echo "🚀 OpenClaw World Model Deployment"
echo "===================================="
echo ""

# ─── Step 1: Check Prerequisites ───

echo "📋 Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "✅ Node.js installed"
else
    echo "✅ Node.js found: $(node --version)"
fi

if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm not found. Installing..."
    npm install -g pnpm
    echo "✅ pnpm installed"
else
    echo "✅ pnpm found: $(pnpm --version)"
fi

if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 not found. Installing..."
    npm install -g pm2
    echo "✅ PM2 installed"
else
    echo "✅ PM2 found"
fi

echo ""

# ─── Step 2: Install Dependencies ───

echo "📦 Installing project dependencies..."
pnpm install
echo "✅ Dependencies installed"
echo ""

# ─── Step 3: Setup Environment ───

echo "⚙️  Setting up environment..."

if [ ! -f .env ]; then
    echo "❌ .env file not found. Creating from template..."

    if [ ! -f .env.example ]; then
        cat > .env.example << 'EOF'
# Telegram
OPENCLAW_TELEGRAM_TOKEN=your_bot_token_here
OPENCLAW_TELEGRAM_ADMIN_ID=your_telegram_id

# World Model
WORLD_MODEL_ENABLED=true
WORLD_MODEL_PROVIDER=lstm
WORLD_MODEL_DATA_DIR=./world-model-data

# Optional: LLM API Keys
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_API_KEY=
EOF
    fi

    cp .env.example .env
    echo "⚠️  Created .env from template"
    echo "🔴 IMPORTANT: Edit .env and add your Telegram bot token:"
    echo "   nano .env"
    echo ""
    echo "To get a Telegram bot token:"
    echo "  1. Message @BotFather on Telegram"
    echo "  2. Create new bot: /newbot"
    echo "  3. Copy the token to .env"
    echo ""
fi

echo "✅ Environment ready"
echo ""

# ─── Step 4: Run Tests ───

echo "🧪 Running tests..."
npx ts-node test-lstm-world-model.ts 2>/dev/null && TEST_PASSED=1 || TEST_PASSED=0

if [ $TEST_PASSED -eq 1 ]; then
    echo "✅ All tests passed!"
else
    echo "⚠️  Some tests failed. This might be due to missing node_modules."
    echo "   Try: pnpm install && npx tsc --noEmit"
fi
echo ""

# ─── Step 5: Create Data Directory ───

echo "📁 Creating data directories..."
mkdir -p world-model-data
echo "✅ Directories created"
echo ""

# ─── Step 6: Setup PM2 ───

echo "🔄 Configuring PM2..."

# Stop existing process if it exists
pm2 stop openclaw-agent 2>/dev/null || true
pm2 delete openclaw-agent 2>/dev/null || true

# Start with PM2
pm2 start "pnpm start" --name "openclaw-agent" --error ./openclaw-agent.err.log --out ./openclaw-agent.out.log
pm2 save
pm2 startup

echo "✅ PM2 configured"
echo ""

# ─── Step 7: Summary ───

echo "✅ Deployment Complete!"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "🎉 OpenClaw Agent is running!"
echo ""
echo "📊 Status:"
pm2 status
echo ""
echo "📖 Next Steps:"
echo "  1. Edit .env with your Telegram bot token:"
echo "     nano .env"
echo ""
echo "  2. Find your Telegram ID (send /start to @userinfobot)"
echo ""
echo "  3. Test the agent:"
echo "     - Message your bot on Telegram"
echo "     - Watch logs: pm2 logs openclaw-agent"
echo ""
echo "  4. Monitor dream training (starts nightly at 2 AM):"
echo "     tail -f openclaw-agent.out.log | grep dream"
echo ""
echo "📁 Important Files:"
echo "  - Config: openclaw.json"
echo "  - Environment: .env"
echo "  - Logs: pm2 logs openclaw-agent"
echo "  - Training data: world-model-data/"
echo ""
echo "🛠️  Useful Commands:"
echo "  pm2 logs openclaw-agent        # View logs"
echo "  pm2 stop openclaw-agent        # Stop agent"
echo "  pm2 restart openclaw-agent     # Restart"
echo "  pm2 delete openclaw-agent      # Remove from PM2"
echo ""
echo "📞 Get Help:"
echo "  - Logs: pm2 logs"
echo "  - Check config: cat openclaw.json"
echo "  - World Model: cat WORLD_MODEL_QUICKSTART.md"
echo ""
echo "🌐 Telegram Bot URL:"
echo "  https://t.me/YOUR_BOT_NAME"
echo ""
echo "════════════════════════════════════════════════════════════════"
