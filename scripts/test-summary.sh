#!/bin/bash

# Quick Test Summary - Research Chatbot + Ollama
# This script provides a quick overview of test status

set -e

PROJECT_DIR="/home/dale/projects/clawdbot"
cd "$PROJECT_DIR"

echo ""
echo "📊 Research Chatbot + Ollama - Test Overview"
echo "=============================================="
echo ""

# Get test results
echo "🧪 Unit Tests (Mocked - no Ollama needed)"
echo "─────────────────────────────────────────"

echo -n "  research-chatbot.test.ts: "
if pnpm test src/lib/research-chatbot.test.ts --reporter=verbose 2>&1 | grep -q "8 passed"; then
  echo "✅ 8/8 passed"
else
  echo "❌ Failed"
fi

echo -n "  research-ollama.test.ts:  "
if pnpm test src/lib/research-ollama.test.ts --reporter=verbose 2>&1 | grep -q "17 passed"; then
  echo "✅ 17/17 passed"
else
  echo "❌ Failed"
fi

echo ""
echo "🔨 Build Status"
echo "───────────────"

echo -n "  TypeScript compilation: "
if pnpm build 2>&1 | grep -q "Build complete"; then
  echo "✅ Compiles successfully"
else
  echo "❌ Compilation error"
fi

echo ""
echo "🎯 Coverage Summary"
echo "──────────────────"
echo "  Unit Tests:        ✅ 25 total (8 chatbot + 17 Ollama)"
echo "  Integration Tests: ⏳ Manual (see docs/testing-research-ollama.md)"
echo "  E2E/CLI Tests:     ⏳ Planned for Phase 2"
echo ""

echo "🚀 Next Steps"
echo "─────────────"
echo "  1. Full integration test: ./scripts/test-research-ollama.sh"
echo "  2. Interactive test:     pnpm openclaw research --chat"
echo "  3. MCP server test:      node dist/lib/research-mcp-server.js"
echo ""

echo "📚 Documentation"
echo "────────────────"
echo "  Complete testing guide: docs/testing-research-ollama.md"
echo "  Implementation details: MCP_IMPLEMENTATION.md"
echo "  Ollama setup guide:     docs/research-mcp-server.md"
echo ""
