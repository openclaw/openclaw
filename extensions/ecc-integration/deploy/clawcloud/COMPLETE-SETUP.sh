#!/bin/bash

# OpenClaw ECC Complete Setup Script
# This script configures everything via terminal commands

set -e  # Exit on any error

echo "🚀 OpenClaw ECC Complete Setup Starting..."
echo "=========================================="

# Configuration
CLAWCLOUD_URL="https://run.claw.cloud"
APP_NAME="openclaw-ecc"
NVIDIA_API_KEY="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"
DATABASE_URL="https://ep-blue-morning-a1zjgpm2.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1"
REDIS_URL="https://open-bullfrog-15428.upstash.io"
TELEGRAM_USER_ID="7848084308"

echo "📋 Configuration loaded"
echo "App: $APP_NAME"
echo "NVIDIA API: ${NVIDIA_API_KEY:0:20}..."
echo "Database: ${DATABASE_URL:0:40}..."
echo "Redis: ${REDIS_URL:0:30}..."
echo ""

# Step 1: Create final configuration JSON
echo "📝 Creating final configuration..."
cat > /tmp/ecc-final-config.json << 'EOF'
{
  "models": {
    "mode": "merge",
    "providers": {
      "openai": {
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "apiKey": "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",
        "auth": "api-key",
        "api": "openai-responses",
        "models": [
          {
            "id": "qwen/qwen3.5-397b-a17b",
            "name": "qwen/qwen3.5-397b-a17b",
            "api": "openai-responses",
            "reasoning": false,
            "input": ["text"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ],
        "authHeader": false
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/qwen/qwen3.5-397b-a17b"
      },
      "models": {
        "openai/qwen/qwen3.5-397b-a17b": {}
      },
      "workspace": "/home/clawdbot/workspace",
      "compaction": {
        "mode": "safeguard"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "gateway": {
    "mode": "local",
    "trustedProxies": ["172.16.0.0/16", "172.20.0.0/16", "127.0.0.1"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
    }
  },
  "plugins": {
    "entries": {
      "telegram": {
        "enabled": true
      },
      "ecc-integration": {
        "enabled": true,
        "governance": {
          "enabled": true,
          "rulesMode": "strict"
        },
        "learning": {
          "enabled": true,
          "continuous": true
        },
        "security": {
          "enabled": true,
          "autoAudit": true
        }
      }
    }
  },
  "web": {
    "enabled": true
  },
  "cron": {
    "enabled": true
  },
  "approvals": {
    "exec": {
      "enabled": true,
      "mode": "both"
    }
  },
  "media": {
    "preserveFilenames": true
  },
  "broadcast": {
    "strategy": "parallel"
  }
}
EOF

echo "✅ Configuration created"

# Step 2: Install required tools
echo "🔧 Installing required tools..."
if command -v curl &> /dev/null; then
    echo "✅ curl already installed"
else
    echo "❌ curl is required but not installed"
    exit 1
fi

if command -v jq &> /dev/null; then
    echo "✅ jq already installed"
else
    echo "📦 Installing jq..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install jq
    else
        sudo apt-get update && sudo apt-get install -y jq
    fi
fi

# Step 3: Create environment variables script
echo "🌍 Creating environment variables setup..."
cat > /tmp/setup-env.sh << EOF
#!/bin/bash

echo "🔧 Setting up environment variables for $APP_NAME..."

# Environment variables to add
ENV_VARS=(
    "NVIDIA_API_KEY=$NVIDIA_API_KEY"
    "DATABASE_URL=$DATABASE_URL"
    "REDIS_URL=$REDIS_URL"
    "CLAWDBOT_TELEGRAM_USER_ID=$TELEGRAM_USER_ID"
    "GATEWAY_TRUSTED_PROXIES=172.16.0.0/16,172.20.0.0/16,127.0.0.1"
    "GATEWAY_MODE=local"
    "GMAIL_WATCHER_ENABLED=false"
    "GATEWAY_AUTO_RESTART=false"
)

echo "📋 Environment variables to add:"
for var in "\${ENV_VARS[@]}"; do
    echo "  \$var"
done

echo ""
echo "🔗 Manual steps required:"
echo "1. Go to: $CLAWCLOUD_URL"
echo "2. Navigate to your app: $APP_NAME"
echo "3. Go to Environment Variables section"
echo "4. Add each variable from the list above"
echo "5. Restart the application"
echo ""

# Create a simple script to copy variables
cat > /tmp/env-vars.txt << EOV
\$(printf "%s\n" "\${ENV_VARS[@]}")
EOV

echo "📄 Environment variables saved to /tmp/env-vars.txt"
echo "📋 Copy from there or use the list above"
EOF

chmod +x /tmp/setup-env.sh
/tmp/setup-env.sh

# Step 4: Create verification script
echo "🔍 Creating verification script..."
cat > /tmp/verify-setup.sh << 'EOF'
#!/bin/bash

echo "🔍 OpenClaw ECC Setup Verification"
echo "================================="

# Test configuration JSON
echo "📝 Testing configuration JSON..."
if jq empty /tmp/ecc-final-config.json 2>/dev/null; then
    echo "✅ Configuration JSON is valid"
else
    echo "❌ Configuration JSON has errors"
    exit 1
fi

# Check NVIDIA API key format
echo "🔑 Checking NVIDIA API key..."
if grep -q "nvapi-" /tmp/ecc-final-config.json; then
    echo "✅ NVIDIA API key found"
else
    echo "❌ NVIDIA API key missing"
fi

# Check database URL
echo "🗄️ Checking database URL..."
if grep -q "neon.tech" /tmp/ecc-final-config.json; then
    echo "✅ Database URL found"
else
    echo "❌ Database URL missing"
fi

# Check Redis URL
echo "🔴 Checking Redis URL..."
if grep -q "upstash.io" /tmp/ecc-final-config.json; then
    echo "✅ Redis URL found"
else
    echo "❌ Redis URL missing"
fi

# Check ECC configuration
echo "🧠 Checking ECC configuration..."
if grep -q "ecc-integration" /tmp/ecc-final-config.json; then
    echo "✅ ECC integration found"
    if grep -q '"governance".*"enabled".*true' /tmp/ecc-final-config.json; then
        echo "✅ ECC governance enabled"
    fi
    if grep -q '"learning".*"enabled".*true' /tmp/ecc-final-config.json; then
        echo "✅ ECC learning enabled"
    fi
    if grep -q '"security".*"enabled".*true' /tmp/ecc-final-config.json; then
        echo "✅ ECC security enabled"
    fi
else
    echo "❌ ECC integration missing"
fi

echo ""
echo "🎯 Next Steps:"
echo "1. Apply environment variables to your ClawCloud app"
echo "2. Restart the application"
echo "3. Test with Telegram bot: /onboard"
echo "4. Verify with: /status, /models, /skills"
EOF

chmod +x /tmp/verify-setup.sh

# Step 5: Create test commands script
echo "🧪 Creating test commands script..."
cat > /tmp/test-commands.sh << 'EOF'
#!/bin/bash

echo "🧪 OpenClaw ECC Test Commands"
echo "============================"

echo "📱 Telegram Bot Commands to Test:"
echo "  /onboard     - Run ECC onboarding wizard"
echo "  /status      - Check system status"
echo "  /models      - List available models"
echo "  /skills      - List ECC skills"
echo "  /audit       - Test security scanner"
echo "  /help        - Show all commands"
echo ""

echo "🌐 Web Interface Tests:"
echo "  URL: http://your-app-url.cloud.run"
echo "  - Check dashboard"
echo "  - Test configuration"
echo "  - Verify ECC features"
echo ""

echo "🔍 API Tests (if you have curl):"
echo "  curl http://your-app-url.cloud.run/health"
echo "  curl http://your-app-url.cloud.run/models"
echo ""

echo "📊 Expected Results:"
echo "  ✅ No proxy warnings in logs"
echo "  ✅ Database persistence enabled"
echo "  ✅ ECC governance active"
echo "  ✅ Learning system running"
echo "  ✅ Security scanner enabled"
echo "  ✅ NVIDIA models available"
EOF

chmod +x /tmp/test-commands.sh

# Step 6: Run verification
echo "🔍 Running setup verification..."
/tmp/verify-setup.sh

echo ""
echo "🎉 Setup Complete!"
echo "=================="
echo ""
echo "📁 Files created:"
echo "  /tmp/ecc-final-config.json    - Final configuration"
echo "  /tmp/setup-env.sh            - Environment variables helper"
echo "  /tmp/verify-setup.sh         - Verification script"
echo "  /tmp/test-commands.sh        - Test commands"
echo "  /tmp/env-vars.txt            - Environment variables list"
echo ""
echo "🚀 Next Steps:"
echo "  1. Run: /tmp/setup-env.sh"
echo "  2. Add environment variables to ClawCloud"
echo "  3. Restart your application"
echo "  4. Test with: /tmp/test-commands.sh"
echo ""
echo "📱 Quick Test:"
echo "  Send '/onboard' to @picklerick777bot"
echo ""
echo "✨ Your OpenClaw ECC system will be fully configured!"
