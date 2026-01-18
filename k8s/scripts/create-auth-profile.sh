#!/bin/sh
set -e

AUTH_DIR="/home/node/.clawdbot/agents/main/agent"
AUTH_FILE="$AUTH_DIR/auth-profiles.json"

echo "Creating auth profiles directory: $AUTH_DIR"
mkdir -p "$AUTH_DIR"

# Create auth-profiles.json with API key from environment
echo "Generating auth-profiles.json..."

if [ -n "$ANTHROPIC_API_KEY" ] && [ "$ANTHROPIC_API_KEY" != "sk-ant-placeholder" ]; then
  cat > "$AUTH_FILE" <<'EOF'
{
  "profiles": {
    "anthropic:env-key": {
      "provider": "anthropic",
      "mode": "api_key"
    }
  },
  "order": {
    "anthropic": ["anthropic:env-key"]
  }
}
EOF
  echo "✅ Auth profile created with Anthropic API key"
elif [ -n "$OPENAI_API_KEY" ]; then
  cat > "$AUTH_FILE" <<'EOF'
{
  "profiles": {
    "openai:env-key": {
      "provider": "openai",
      "mode": "api_key"
    }
  },
  "order": {
    "openai": ["openai:env-key"]
  }
}
EOF
  echo "✅ Auth profile created with OpenAI API key"
else
  echo "⚠️ No valid API key found, creating minimal auth profile"
  cat > "$AUTH_FILE" <<'EOF'
{
  "profiles": {},
  "order": {}
}
EOF
fi

echo "Auth profile file created at: $AUTH_FILE"
cat "$AUTH_FILE"
