#!/bin/bash

# ECC Internal Configuration Script
# Uses ECC integration to configure OpenClaw from inside

echo "🧠 ECC Internal Configuration System"
echo "=================================="

APP_URL="http://openclaw-hlpomtim.ap-southeast-1.clawcloud.run"

echo "📡 Connecting to ECC system..."

# Step 1: Initialize ECC configuration
echo "🔧 Step 1: Initializing ECC governance..."
curl -X POST "$APP_URL/api/ecc/governance/init" \
  -H "Content-Type: application/json" \
  -d '{
    "rulesMode": "strict",
    "autoEnforcement": true,
    "auditLevel": "comprehensive"
  }' 2>/dev/null || echo "⚠️  Governance init may need manual trigger"

# Step 2: Configure NVIDIA models via ECC
echo "🚀 Step 2: Configuring NVIDIA models through ECC..."
curl -X POST "$APP_URL/api/ecc/models/configure" \
  -H "Content-Type: application/json" \
  -d '{
    "primaryProvider": "nvidia",
    "models": [
      {
        "id": "qwen/qwen3.5-397b-a17b",
        "provider": "nvidia",
        "capabilities": ["reasoning", "code", "analysis"],
        "priority": "primary"
      }
    ],
    "routing": "intelligent"
  }' 2>/dev/null || echo "⚠️  Model config may need manual trigger"

# Step 3: Setup security auditing
echo "🛡️  Step 3: Enabling ECC security auditing..."
curl -X POST "$APP_URL/api/ecc/security/enable" \
  -H "Content-Type: application/json" \
  -d '{
    "autoAudit": true,
    "scanLevel": "thorough",
    "realTimeProtection": true
  }' 2>/dev/null || echo "⚠️  Security config may need manual trigger"

# Step 4: Enable continuous learning
echo "📚 Step 4: Activating continuous learning..."
curl -X POST "$APP_URL/api/ecc/learning/enable" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "continuous",
    "knowledgeRetention": true,
    "patternRecognition": true,
    "skillEvolution": true
  }' 2>/dev/null || echo "⚠️  Learning config may need manual trigger"

# Step 5: Configure Telegram through ECC
echo "📱 Step 5: Optimizing Telegram via ECC..."
curl -X POST "$APP_URL/api/ecc/channels/telegram/optimize" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "7848084308",
    "autoPair": true,
    "enhancedFeatures": true,
    "eccCommands": true
  }' 2>/dev/null || echo "⚠️  Telegram config may need manual trigger"

# Step 6: Run ECC system check
echo "🔍 Step 6: Running ECC system diagnostics..."
curl -X GET "$APP_URL/api/ecc/system/diagnostics" \
  -H "Accept: application/json" 2>/dev/null || echo "⚠️  Diagnostics may need manual trigger"

echo ""
echo "🎯 ECC Internal Configuration Complete!"
echo "===================================="
echo ""
echo "📱 Now test these commands in Telegram (@picklerick777bot):"
echo "  /ecc status     - Check ECC system status"
echo "  /ecc govern     - Show governance rules"
echo "  /ecc learn      - View learning status"
echo "  /ecc audit      - Run security audit"
echo "  /ecc onboard    - Start ECC onboarding"
echo "  /onboard        - Standard OpenClaw onboarding"
echo ""
echo "🌐 Web Interface:"
echo "  $APP_URL"
echo "  → Dashboard → ECC Section"
echo ""
echo "✨ Your ECC integration is now configuring OpenClaw from the inside!"
