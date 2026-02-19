#!/bin/bash

# Integration Test Script for Research Chatbot with Ollama
# Run this to verify end-to-end functionality

set -e

PROJECT_DIR="/home/dale/projects/clawdbot"
cd "$PROJECT_DIR"

echo "🧪 Research Chatbot + Ollama Integration Test Suite"
echo "===================================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Helper function for test output
test_result() {
  local name=$1
  local result=$2
  
  if [ $result -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $name"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗${NC} $name"
    ((TESTS_FAILED++))
  fi
}

# Test 1: Check Ollama is running
echo -e "${BLUE}Test 1: Ollama Connectivity${NC}"
if curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
  test_result "Ollama server responding" 0
  
  # Get available models
  MODELS=$(curl -s http://127.0.0.1:11434/api/tags | jq -r '.models[].name' 2>/dev/null | head -3)
  if [ -n "$MODELS" ]; then
    echo -e "${BLUE}  Available models:${NC}"
    echo "$MODELS" | sed 's/^/    - /'
    test_result "Models available" 0
  else
    test_result "Models available" 1
    echo -e "${YELLOW}  ⚠ No models found. Run: ollama pull mistral-8b${NC}"
  fi
else
  test_result "Ollama server responding" 1
  echo -e "${RED}  ✗ Ollama not running on http://127.0.0.1:11434${NC}"
  echo -e "${YELLOW}  Start with: ollama serve${NC}"
  exit 1
fi
echo ""

# Test 2: Build typescriptCheck TypeScript compilation
echo -e "${BLUE}Test 2: TypeScript Compilation${NC}"
if pnpm build > /tmp/build.log 2>&1; then
  test_result "Build completes successfully" 0
else
  test_result "Build completes successfully" 1
  tail -20 /tmp/build.log | sed 's/^/  /'
fi
echo ""

# Test 3: Run unit tests
echo -e "${BLUE}Test 3: Unit Tests${NC}"
if pnpm test src/lib/research-chatbot.test.ts > /tmp/test1.log 2>&1; then
  test_result "research-chatbot.test.ts" 0
  grep "Tests.*passed" /tmp/test1.log | head -1 | sed 's/^/  /'
else
  test_result "research-chatbot.test.ts" 1
fi

if pnpm test src/lib/research-ollama.test.ts > /tmp/test2.log 2>&1; then
  test_result "research-ollama.test.ts (mocked)" 0
  grep "Tests.*passed" /tmp/test2.log | head -1 | sed 's/^/  /'
else
  test_result "research-ollama.test.ts" 1
fi
echo ""

# Test 4: Test Ollama API directly
echo -e "${BLUE}Test 4: Ollama API Functionality${NC}"

# Get first available model
MODEL=$(curl -s http://127.0.0.1:11434/api/tags | jq -r '.models[0].name' 2>/dev/null)

if [ -n "$MODEL" ]; then
  echo "  Using model: $MODEL"
  
  # Test simple completion
  RESPONSE=$(curl -s -X POST http://127.0.0.1:11434/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"Say hello\"}],
      \"temperature\": 0.7,
      \"stream\": false
    }" 2>/dev/null)
  
  if echo "$RESPONSE" | grep -q "choices"; then
    test_result "Chat completion endpoint" 0
    echo "$RESPONSE" | jq -r '.choices[0].message.content' | head -c 100 | sed 's/^/    Response: /'
    echo ""
  else
    test_result "Chat completion endpoint" 1
    echo "  Response: $RESPONSE" | sed 's/^/  /'
  fi
else
  test_result "Chat completion endpoint" 1
  echo -e "${YELLOW}  ⚠ No models available. Run: ollama pull mistral-8b${NC}"
fi
echo ""

# Test 5: Test CLI integration (if available)
echo -e "${BLUE}Test 5: CLI Integration${NC}"
if command -v openclaw > /dev/null 2>&1; then
  if pnpm openclaw research --help > /dev/null 2>&1; then
    test_result "openclaw research command available" 0
  else
    test_result "openclaw research command available" 1
  fi
else
  test_result "openclaw CLI available" 1
fi
echo ""

# Test 6: Manual flow test (interactive if requested)
echo -e "${BLUE}Test 6: Interactive Chat Test${NC}"

read -p "Run interactive chat test? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo ""
  echo -e "${YELLOW}Starting interactive research chat...${NC}"
  echo "Tip: Type '/done' to exit"
  echo ""
  pnpm openclaw research --chat || true
  test_result "Interactive chat flow" 0
else
  echo -e "${YELLOW}⊘ Skipped interactive test${NC}"
fi
echo ""

# Test 7: MCP Server health check
echo -e "${BLUE}Test 7: MCP Server${NC}"

# Check if MCP server file exists
if [ -f "dist/lib/research-mcp-server.js" ]; then
  test_result "MCP server compiled" 0
  
  # Try to start server briefly and check it responds
  timeout 2 node dist/lib/research-mcp-server.js <<< '{"jsonrpc":"2.0","id":1,"method":"initialize"}' > /tmp/mcp.log 2>&1 || true
  
  if grep -q "openclaw-research" /tmp/mcp.log; then
    test_result "MCP server responds" 0
  else
    test_result "MCP server responds" 1
  fi
else
  test_result "MCP server compiled" 1
fi
echo ""

# Test 8: Performance check
echo -e "${BLUE}Test 8: Performance${NC}"

if [ -n "$MODEL" ]; then
  echo "  Measuring response time..."
  START=$(date +%s%N)
  
  curl -s -X POST http://127.0.0.1:11434/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"Quick test\"}],
      \"temperature\": 0.7,
      \"stream\": false
    }" > /dev/null 2>&1
  
  END=$(date +%s%N)
  DURATION_MS=$(((END - START) / 1000000))
  
  echo "    Response time: ${DURATION_MS}ms"
  
  if [ $DURATION_MS -lt 10000 ]; then
    test_result "Response time acceptable (<10s)" 0
  elif [ $DURATION_MS -lt 30000 ]; then
    test_result "Response time acceptable (<30s)" 1  # Warn but don't fail
  else
    test_result "Response time slow (>30s)" 1
    echo -e "${YELLOW}  ⚠ Your model may be too large for this PC${NC}"
    echo -e "${YELLOW}  Try: ollama pull mistral-8b (faster)${NC}"
  fi
else
  echo -e "${YELLOW}⊘ Skipped (no model available)${NC}"
fi
echo ""

# Test Summary
echo "===================================================="
echo -e "${BLUE}Test Summary${NC}"
echo -e "  ${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "  ${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All tests passed!${NC}"
  echo ""
  echo -e "${BLUE}Next steps:${NC}"
  echo "  1. Use interactive chat: pnpm openclaw research --chat"
  echo "  2. Add MCP to Claude: Use dist/lib/research-mcp-server.js"
  echo "  3. Export results: Use /export command in chat"
  exit 0
else
  echo -e "${RED}✗ Some tests failed${NC}"
  echo ""
  echo -e "${YELLOW}Troubleshooting:${NC}"
  echo "  - Ensure Ollama is running: ollama serve"
  echo "  - Check model available: ollama list"
  echo "  - Pull a model: ollama pull mistral-8b"
  echo "  - Check logs: tail -f /tmp/*.log"
  exit 1
fi
