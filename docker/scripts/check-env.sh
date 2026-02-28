#!/bin/bash
# Pre-deployment environment validation
#
# Usage: bash docker/scripts/check-env.sh
# Verifies all required environment variables are set and non-empty
# Shows masked first/last chars for security verification
#
# Exit code: 0 = all OK, 1 = missing required vars

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

MISSING_VARS=()
CHECKED_VARS=()

# Helper to check a variable
check_var() {
  local var_name="$1"
  local var_value="${!var_name:-}"
  
  if [ -z "$var_value" ]; then
    MISSING_VARS+=("$var_name")
    echo -e "${RED}✗ $var_name${NC} (missing)"
  else
    CHECKED_VARS+=("$var_name")
    # Show first 8 and last 4 chars for verification
    local first_8="${var_value:0:8}"
    local last_4="${var_value: -4}"
    local len=${#var_value}
    echo -e "${GREEN}✓ $var_name${NC} (${len} chars: $first_8....$last_4)"
  fi
}

echo "=================================================="
echo "   OpenClaw Environment Validation"
echo "=================================================="
echo ""

# Required for gateway communication
echo "🔐 Gateway Authentication:"
check_var "OPENCLAW_GATEWAY_TOKEN"
echo ""

# Required for LLM providers (at least one)
echo "🤖 LLM Providers (at least one required):"
check_var "OPENROUTER_API_KEY"
check_var "ANTHROPIC_API_KEY"
check_var "OPENAI_API_KEY"
echo ""

# Required for LINE channel
echo "📱 LINE Channel:"
check_var "LINE_CHANNEL_SECRET"
check_var "LINE_CHANNEL_ACCESS_TOKEN"
echo ""

# Required for web search
echo "🔍 Web Search (Brave):"
check_var "BRAVE_API_KEY"
check_var "BRAVE_API_SEARCH_KEY"
check_var "BRAVE_API_ANSWER_KEY"
echo ""

# Optional but recommended
echo "📋 Optional (recommended):"
check_var "OPENAI_API_KEY" 2>/dev/null || echo -e "${YELLOW}⊘ OPENAI_API_KEY${NC} (optional, for embeddings)"
check_var "TZ" 2>/dev/null || echo -e "${YELLOW}⊘ TZ${NC} (optional, defaults to Asia/Bangkok)"
echo ""

# Summary
echo "=================================================="
if [ ${#MISSING_VARS[@]} -eq 0 ]; then
  echo -e "${GREEN}✓ All required environment variables set${NC}"
  echo ""
  echo "Checked: ${#CHECKED_VARS[@]} variables"
  echo ""
  echo "Ready to deploy:"
  echo "  docker compose -f docker/docker-compose.prod.yml up -d"
  echo ""
  exit 0
else
  echo -e "${RED}✗ Missing required environment variables:${NC}"
  for var in "${MISSING_VARS[@]}"; do
    echo -e "  ${RED}→ $var${NC}"
  done
  echo ""
  echo "Action: Set these variables in Hostinger UI or .env file:"
  echo "  See docs/CI-CD-WORKFLOW.md Step 5 for details"
  echo ""
  exit 1
fi
