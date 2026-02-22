#!/bin/bash
# Test AWS Bedrock model access and list available Claude models
# Helps diagnose "model not found" errors

set -e

echo "🧪 AWS Bedrock Model Tester"
echo "============================"
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo "❌ Error: AWS CLI not installed"
    echo "   Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

# Check credentials
echo "🔐 Checking AWS credentials..."
if aws sts get-caller-identity &> /dev/null; then
    ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    USER=$(aws sts get-caller-identity --query Arn --output text | cut -d'/' -f2)
    echo "   ✅ Authenticated as: $USER"
    echo "   Account: $ACCOUNT"
else
    echo "   ❌ AWS credentials not configured"
    echo "   Run: aws configure"
    exit 1
fi

# Get region
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
echo "   Region: $REGION"
echo ""

# List Bedrock models
echo "📋 Listing Bedrock models..."
echo ""

if ! aws bedrock list-foundation-models --region "$REGION" --output json > /tmp/bedrock-models.json 2>&1; then
    echo "❌ Failed to list models. Check:"
    echo "   1. Bedrock is available in $REGION"
    echo "   2. IAM permissions include bedrock:ListFoundationModels"
    echo "   3. Model access is enabled in Bedrock console"
    exit 1
fi

# Extract Claude models
echo "🤖 Available Claude Models:"
echo ""

jq -r '.modelSummaries[] | select(.providerName == "Anthropic") | "\(.modelId) - \(.modelName)"' \
    /tmp/bedrock-models.json | sort | while read -r line; do
    echo "   ✅ $line"
done

echo ""
echo "📝 For cross-region inference from us-east-1, use these model IDs:"
echo ""

jq -r '.modelSummaries[] | select(.providerName == "Anthropic") | .modelId' \
    /tmp/bedrock-models.json | sort | while read -r model; do
    # Add us. prefix for cross-region
    if [[ $model == anthropic.* ]]; then
        echo "   us.$model"
    else
        echo "   $model"
    fi
done

echo ""
echo "🧪 Testing model access..."
echo ""

# Test a simple model invocation
TEST_MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0"
TEST_PROMPT="Hello, this is a test. Respond with just 'OK'."

echo "   Testing: $TEST_MODEL"
echo "   Prompt: \"$TEST_PROMPT\""
echo ""

# Create test payload
cat > /tmp/bedrock-test.json <<EOF
{
    "modelId": "$TEST_MODEL",
    "messages": [
        {
            "role": "user",
            "content": [{"text": "$TEST_PROMPT"}]
        }
    ],
    "inferenceConfig": {
        "maxTokens": 100
    }
}
EOF

if aws bedrock-runtime converse \
    --cli-input-json file:///tmp/bedrock-test.json \
    --region "$REGION" \
    --output json > /tmp/bedrock-response.json 2>&1; then

    RESPONSE=$(jq -r '.output.message.content[0].text' /tmp/bedrock-response.json)
    echo "   ✅ Model responded: \"$RESPONSE\""
    echo ""
    echo "   Success! Bedrock is working correctly."
else
    echo "   ❌ Model invocation failed"
    echo "   Error: $(cat /tmp/bedrock-response.json)"
    echo ""
    echo "   This may mean:"
    echo "   - Model access not enabled in Bedrock console"
    echo "   - Insufficient IAM permissions"
    echo "   - Model not available in $REGION"
fi

# Cleanup
rm -f /tmp/bedrock-models.json /tmp/bedrock-test.json /tmp/bedrock-response.json

echo ""
echo "💡 Next steps:"
echo "   1. Enable model access: https://console.aws.amazon.com/bedrock"
echo "   2. Configure OpenClaw:"
echo "      openclaw config set models.bedrockDiscovery.enabled true"
echo "      openclaw config set models.bedrockDiscovery.region $REGION"
echo "   3. List models in OpenClaw:"
echo "      openclaw models list | grep bedrock"
