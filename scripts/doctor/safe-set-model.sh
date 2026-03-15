#!/bin/bash
# Safe model configuration setter
# Validates model exists before setting it in config

set -e

MODEL_ID="$1"

if [ -z "$MODEL_ID" ]; then
    echo "Usage: $0 <model-id>"
    echo ""
    echo "This script validates the model ID before setting it in config."
    echo ""
    echo "Examples:"
    echo "  $0 amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
    echo "  $0 openai/gpt-4"
    echo ""
    echo "💡 To see available models:"
    echo "   openclaw models list"
    echo ""
    exit 1
fi

echo "🛡️  Safe Model Configuration"
echo "==========================="
echo ""

# Run validation script
if ! ./scripts/doctor/test-model-access.sh "$MODEL_ID"; then
    echo ""
    echo "❌ Model validation failed"
    echo ""
    echo "Cannot set model in configuration - please fix the issues above."
    exit 1
fi

echo "🔧 Setting model in configuration..."
echo ""

# Get current model
CURRENT_MODEL=$(openclaw config get agents.defaults.model.primary 2>/dev/null | tr -d '"' || echo "none")

if [ "$CURRENT_MODEL" != "none" ] && [ "$CURRENT_MODEL" != "null" ]; then
    echo "📝 Current model: $CURRENT_MODEL"
    echo "   New model: $MODEL_ID"
    echo ""
    read -p "   Replace current model? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Cancelled"
        exit 0
    fi
fi

# Set the model
openclaw config set agents.defaults.model.primary "$MODEL_ID"

echo ""
echo "✅ Model configured successfully!"
echo ""
echo "📋 Current configuration:"
openclaw config get agents.defaults.model
echo ""
echo "🔄 Restart gateway to apply changes:"
echo "   systemctl --user restart openclaw-gateway.service"
echo ""
