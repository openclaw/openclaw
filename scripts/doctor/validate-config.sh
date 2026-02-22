#!/bin/bash
# Config validation helper with user-friendly error messages
# Provides actionable guidance for common configuration issues

set -e

echo "🔍 OpenClaw Config Validator"
echo "============================="
echo ""

CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config file not found: $CONFIG_FILE"
    echo "   Run: openclaw onboard"
    exit 1
fi

echo "📄 Checking: $CONFIG_FILE"
echo ""

# Check if openclaw command exists
if ! command -v openclaw &> /dev/null; then
    echo "❌ openclaw command not found"
    exit 1
fi

# Function to check dmPolicy + allowFrom
check_channel_policy() {
    local channel=$1
    local dm_policy=$(openclaw config get channels.${channel}.dmPolicy 2>/dev/null | tr -d '"' || echo "")
    local allow_from=$(openclaw config get channels.${channel}.allowFrom 2>/dev/null || echo "")

    if [ "$dm_policy" = "open" ]; then
        if [[ ! "$allow_from" =~ \* ]]; then
            echo "❌ ${channel^} Configuration Mismatch"
            echo ""
            echo "   Your configuration has:"
            echo "     dmPolicy: \"open\""
            echo "     allowFrom: ${allow_from:-[]}"
            echo ""
            echo "   When dmPolicy is \"open\", allowFrom must include \"*\" to allow all users."
            echo ""
            echo "   💡 Fix with:"
            echo "      openclaw config set channels.${channel}.allowFrom '[\"*\"]'"
            echo ""
            echo "   Or change policy to require pairing:"
            echo "      openclaw config set channels.${channel}.dmPolicy \"pairing\""
            echo ""
            return 1
        else
            echo "✅ ${channel^}: dmPolicy and allowFrom are consistent"
        fi
    elif [ -n "$dm_policy" ]; then
        echo "✅ ${channel^}: dmPolicy=${dm_policy}"
    fi

    return 0
}

# Function to check model ID validity
check_model_id() {
    local model_id=$(openclaw config get agents.defaults.model.primary 2>/dev/null | tr -d '"' || echo "")

    if [ -z "$model_id" ] || [ "$model_id" = "null" ]; then
        echo "⚠️  No primary model configured"
        echo "   Set with: openclaw config set agents.defaults.model.primary \"<model-id>\""
        echo ""
        return 0
    fi

    echo "🤖 Primary Model: $model_id"

    # Check if model exists in catalog
    if openclaw models list 2>/dev/null | grep -q "$model_id"; then
        echo "✅ Model exists in catalog"
    else
        echo "❌ Model ID Not Found"
        echo ""
        echo "   The configured model \"$model_id\" is not available."
        echo ""
        echo "   💡 Check available models:"
        echo "      openclaw models list | grep -i claude"
        echo ""
        echo "   Common issues:"
        echo "   - Typo in model ID"
        echo "   - Missing provider prefix (e.g., amazon-bedrock/)"
        echo "   - Missing region prefix for Bedrock (e.g., us.anthropic...)"
        echo "   - Model not enabled in your account"
        echo ""
        echo "   💡 For AWS Bedrock in us-east-1, model IDs need \"us.\" prefix:"
        echo "      amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
        echo ""
        return 1
    fi

    return 0
}

# Function to check gateway auth for reverse proxies
check_gateway_auth() {
    local bind=$(openclaw config get gateway.bind 2>/dev/null | tr -d '"' || echo "")
    local allow_insecure=$(openclaw config get gateway.controlUi.allowInsecureAuth 2>/dev/null || echo "false")

    if [ "$bind" = "lan" ] || [ "$bind" = "0.0.0.0" ]; then
        if [ "$allow_insecure" != "true" ]; then
            echo "⚠️  Gateway Bind Warning"
            echo ""
            echo "   Gateway is bound to: $bind"
            echo "   allowInsecureAuth: $allow_insecure"
            echo ""
            echo "   If using a reverse proxy (Cloudflare Tunnel, nginx, Caddy),"
            echo "   you may need to set:"
            echo ""
            echo "   💡 openclaw config set gateway.controlUi.allowInsecureAuth true"
            echo ""
            echo "   This is required because reverse proxies terminate TLS,"
            echo "   making requests appear insecure to OpenClaw."
            echo ""
            return 0
        fi
    fi

    return 0
}

# Run checks
echo "🔍 Checking Channel Configurations..."
echo ""

ERRORS=0

# Check enabled channels
for channel in telegram slack discord signal; do
    enabled=$(openclaw config get channels.${channel}.enabled 2>/dev/null || echo "false")
    if [ "$enabled" = "true" ]; then
        check_channel_policy "$channel" || ((ERRORS++))
        echo ""
    fi
done

echo "🔍 Checking Model Configuration..."
echo ""
check_model_id || ((ERRORS++))
echo ""

echo "🔍 Checking Gateway Configuration..."
echo ""
check_gateway_auth || ((ERRORS++))
echo ""

# Summary
echo "📊 Validation Summary"
echo "===================="
if [ $ERRORS -eq 0 ]; then
    echo "✅ All checks passed!"
    echo ""
    echo "💡 Tip: Run this validator before making config changes"
    exit 0
else
    echo "❌ Found $ERRORS issue(s)"
    echo ""
    echo "Please fix the issues above and run again."
    echo ""
    echo "For more help:"
    echo "  - Documentation: openclaw docs"
    echo "  - Health check: ./scripts/health-check.sh"
    echo "  - GitHub issues: https://github.com/openclaw/openclaw/issues"
    exit 1
fi
