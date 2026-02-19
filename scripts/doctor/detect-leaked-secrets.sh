#!/bin/bash
# Detect potentially leaked secrets in OpenClaw configuration
# Addresses #20912: API keys leaked in system prompt

set -e

echo "🔍 OpenClaw Secret Leak Detector"
echo "================================"
echo ""

CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config file not found: $CONFIG_FILE"
    exit 1
fi

echo "📄 Scanning: $CONFIG_FILE"
echo ""

ISSUES=0

# Patterns for sensitive data
SENSITIVE_PATTERNS=(
    'sk-[A-Za-z0-9]{48}'           # OpenAI API keys
    'sk-ant-[A-Za-z0-9-]{95}'      # Anthropic API keys
    'AIza[0-9A-Za-z-_]{35}'        # Google API keys
    'gsk_[A-Za-z0-9]{32,}'         # Groq API keys
    'xai-[A-Za-z0-9]{48,}'         # xAI API keys
    'Bearer [A-Za-z0-9._-]+'       # Bearer tokens
    'ghp_[A-Za-z0-9]{36}'          # GitHub personal access tokens
    'gho_[A-Za-z0-9]{36}'          # GitHub OAuth tokens
)

echo "🔎 Checking for exposed secrets in config..."
echo ""

# Check if secrets appear in plain text (not in auth profiles)
for pattern in "${SENSITIVE_PATTERNS[@]}"; do
    if grep -E "$pattern" "$CONFIG_FILE" >/dev/null 2>&1; then
        echo "⚠️  Found potential secret matching pattern: $pattern"

        # Don't show the actual secret
        MATCH=$(grep -E "$pattern" "$CONFIG_FILE" | head -1 | cut -c1-50)
        echo "   Context: ${MATCH}..."
        echo ""
        ((ISSUES++))
    fi
done

# Check for common sensitive key names
echo "🔎 Checking for sensitive configuration keys..."
echo ""

SENSITIVE_KEYS=(
    '"apiKey"'
    '"api_key"'
    '"token"'
    '"bearer"'
    '"password"'
    '"secret"'
    '"credential"'
    '"private_key"'
)

for key in "${SENSITIVE_KEYS[@]}"; do
    COUNT=$(grep -c "$key" "$CONFIG_FILE" || echo "0")
    if [ "$COUNT" -gt 0 ]; then
        echo "ℹ️  Found $COUNT occurrence(s) of $key"

        # Check if it's in auth profiles (safe) or elsewhere (potentially unsafe)
        SAFE=$(grep -B5 "$key" "$CONFIG_FILE" | grep -c "auth.*profiles" || echo "0")
        UNSAFE=$((COUNT - SAFE))

        if [ "$UNSAFE" -gt 0 ]; then
            echo "   ⚠️  $UNSAFE occurrence(s) outside auth profiles (may be exposed)"
            ((ISSUES++))
        else
            echo "   ✅ All occurrences in auth profiles (safe)"
        fi
        echo ""
    fi
done

# Check for hardcoded secrets in common locations
echo "🔎 Checking for hardcoded secrets in config sections..."
echo ""

UNSAFE_SECTIONS=(
    "agents.defaults"
    "tools.web"
    "channels"
    "cron"
)

for section in "${UNSAFE_SECTIONS[@]}"; do
    # Extract section and check for sensitive patterns
    SECTION_CONTENT=$(jq -r ".$section // empty" "$CONFIG_FILE" 2>/dev/null || echo "")

    if [ -n "$SECTION_CONTENT" ]; then
        for pattern in "${SENSITIVE_PATTERNS[@]}"; do
            if echo "$SECTION_CONTENT" | grep -E "$pattern" >/dev/null 2>&1; then
                echo "❌ Found potential secret in config section: $section"
                echo "   Pattern: $pattern"
                echo "   This secret may be exposed in system prompts!"
                echo ""
                ((ISSUES++))
            fi
        done
    fi
done

# Check environment variables
echo "🔎 Checking for sensitive data in environment variables..."
echo ""

ENV_FILE="${HOME}/.openclaw/.env"
if [ -f "$ENV_FILE" ]; then
    echo "📄 Found .env file: $ENV_FILE"

    # Check if .env contains secrets that might leak
    for pattern in "${SENSITIVE_PATTERNS[@]}"; do
        if grep -E "$pattern" "$ENV_FILE" >/dev/null 2>&1; then
            echo "⚠️  Found potential secret in .env file"
            echo "   Pattern: $pattern"
            echo "   Ensure this is loaded securely and not interpolated into prompts"
            echo ""
            ((ISSUES++))
        fi
    done
else
    echo "ℹ️  No .env file found (this is okay)"
fi

echo ""
echo "📊 Summary"
echo "=========="

if [ $ISSUES -eq 0 ]; then
    echo "✅ No obvious secret leaks detected!"
    echo ""
    echo "💡 Best practices:"
    echo "   - Store API keys in models.auth.profiles only"
    echo "   - Never hardcode secrets in agent defaults or tools config"
    echo "   - Use environment variables with proper scoping"
    echo "   - Avoid exposing config to multi-user chats"
    echo ""
    exit 0
else
    echo "❌ Found $ISSUES potential issue(s)"
    echo ""
    echo "⚠️  Security Risk: API Key Leak (#20912)"
    echo ""
    echo "If API keys are exposed in config outside auth profiles,"
    echo "they may be interpolated into system prompts and leaked"
    echo "when users ask questions like 'show me your config'."
    echo ""
    echo "🔧 How to fix:"
    echo ""
    echo "1. Move all API keys to auth profiles:"
    echo "   openclaw models auth add --provider <provider>"
    echo ""
    echo "2. Remove hardcoded keys from config:"
    echo "   openclaw config unset <path-to-key>"
    echo ""
    echo "3. Use environment variables only for gateway-level config,"
    echo "   never for model credentials"
    echo ""
    echo "4. For multi-user deployments, use allowFrom to restrict"
    echo "   who can send messages"
    echo ""
    echo "5. Document: docs/gateway/cloudflare-zero-trust.md"
    echo "   Document: docs/troubleshooting/security-hardening.md"
    echo ""
    exit 1
fi
