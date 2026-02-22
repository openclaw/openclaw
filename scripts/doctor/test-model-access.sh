#!/bin/bash
# Model access validator
# Tests if a model ID is valid and accessible before configuration

set -e

MODEL_ID="$1"

if [ -z "$MODEL_ID" ]; then
    echo "Usage: $0 <model-id>"
    echo ""
    echo "Examples:"
    echo "  $0 amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
    echo "  $0 openai/gpt-4"
    echo ""
    echo "This script validates model access before configuring it."
    exit 1
fi

echo "🔍 Model Access Validator"
echo "========================"
echo ""
echo "Testing model: $MODEL_ID"
echo ""

# Check if openclaw command exists
if ! command -v openclaw &> /dev/null; then
    echo "❌ openclaw command not found"
    exit 1
fi

# Extract provider from model ID
PROVIDER=$(echo "$MODEL_ID" | cut -d'/' -f1)

echo "📦 Provider: $PROVIDER"
echo ""

# Check if model exists in catalog
echo "🔍 Checking model catalog..."
if openclaw models list 2>/dev/null | grep -q "^$MODEL_ID"; then
    echo "✅ Model found in catalog"
    echo ""

    # Show model details
    echo "📋 Model Details:"
    openclaw models list 2>/dev/null | grep "^$MODEL_ID" || echo "  (Details not available via list command)"
    echo ""
else
    echo "❌ Model ID not found in catalog"
    echo ""
    echo "This could mean:"
    echo "  1. Model ID has a typo"
    echo "  2. Model not enabled in your account"
    echo "  3. Provider not configured"
    echo "  4. Model discovery hasn't run yet"
    echo ""

    # Try to find similar models
    echo "🔍 Looking for similar models..."
    SEARCH_TERM=$(echo "$MODEL_ID" | rev | cut -d'/' -f1 | rev | cut -d'-' -f1-3)
    SIMILAR=$(openclaw models list 2>/dev/null | grep -i "$SEARCH_TERM" | head -5)

    if [ -n "$SIMILAR" ]; then
        echo "   Did you mean one of these?"
        echo ""
        echo "$SIMILAR" | sed 's/^/     /'
        echo ""
    fi

    # Provider-specific guidance
    case "$PROVIDER" in
        "amazon-bedrock")
            echo "💡 AWS Bedrock Troubleshooting:"
            echo ""
            echo "   1. Check AWS credentials:"
            echo "      aws sts get-caller-identity"
            echo ""
            echo "   2. Verify Bedrock access:"
            echo "      aws bedrock list-foundation-models --region us-east-1"
            echo ""
            echo "   3. For us-east-1, models need region prefix:"
            echo "      us.anthropic.claude-opus-4-5-20251101-v1:0"
            echo ""
            echo "   4. Test Bedrock models:"
            echo "      ./scripts/troubleshooting/test-bedrock-models.sh"
            echo ""
            ;;
        "openai")
            echo "💡 OpenAI Troubleshooting:"
            echo ""
            echo "   1. Check API key is set:"
            echo "      openclaw config get models.providers.openai.apiKey"
            echo ""
            echo "   2. Verify model name:"
            echo "      https://platform.openai.com/docs/models"
            echo ""
            ;;
        "anthropic")
            echo "💡 Anthropic API Troubleshooting:"
            echo ""
            echo "   1. Check API key is set:"
            echo "      openclaw config get models.providers.anthropic.apiKey"
            echo ""
            echo "   2. Verify model name:"
            echo "      https://docs.anthropic.com/en/docs/models-overview"
            echo ""
            ;;
    esac

    exit 1
fi

# Test model authentication (provider-specific)
echo "🔑 Testing provider authentication..."

case "$PROVIDER" in
    "amazon-bedrock")
        if command -v aws &> /dev/null; then
            if aws sts get-caller-identity &> /dev/null 2>&1; then
                ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
                echo "✅ AWS credentials valid (Account: $ACCOUNT)"
            else
                echo "❌ AWS credentials not configured or invalid"
                echo "   Run: aws configure"
                exit 1
            fi

            # Extract model ID for Bedrock API call
            BEDROCK_MODEL_ID=$(echo "$MODEL_ID" | rev | cut -d'/' -f1 | rev)
            REGION="us-east-1"

            echo ""
            echo "🔍 Testing Bedrock model invocation..."

            # Try a minimal invocation
            TEST_OUTPUT=$(aws bedrock-runtime invoke-model \
                --region "$REGION" \
                --model-id "$BEDROCK_MODEL_ID" \
                --body '{"anthropic_version":"bedrock-2023-05-31","messages":[{"role":"user","content":[{"type":"text","text":"Hi"}]}],"max_tokens":10}' \
                /dev/stdout 2>&1)

            if [ $? -eq 0 ]; then
                echo "✅ Model invocation successful"
            else
                echo "❌ Model invocation failed"
                echo ""
                echo "Error details:"
                echo "$TEST_OUTPUT" | grep -i "error" | head -3
                echo ""
                echo "💡 Common causes:"
                echo "   - Model not enabled in your AWS account"
                echo "   - Insufficient IAM permissions"
                echo "   - Model ID typo"
                echo "   - Region mismatch"
                exit 1
            fi
        else
            echo "⚠️  AWS CLI not installed - skipping auth test"
        fi
        ;;
    *)
        echo "⚠️  Provider-specific auth test not implemented for: $PROVIDER"
        echo "   Model validation passed, but runtime access not tested"
        ;;
esac

echo ""
echo "✅ Model Access Test Complete"
echo ""
echo "📝 Next Steps:"
echo ""
echo "   Configure this model:"
echo "     openclaw config set agents.defaults.model.primary \"$MODEL_ID\""
echo ""
echo "   Restart gateway:"
echo "     systemctl --user restart openclaw-gateway.service"
echo ""
echo "   Send a test message to verify it works end-to-end"
echo ""
