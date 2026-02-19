#!/bin/bash
export OPENCLAW_GATEWAY_TOKEN="e2e-test-token-fixed"
export OLLAMA_API_KEY="ollama-local"
echo "Cleaning up stuck ports..."
lsof -ti:18789,19001 | xargs kill -9 2>/dev/null || true
echo "Starting Gateway..."
npm run dev -- gateway > gateway_test.log 2>&1 &
GATEWAY_PID=$!
echo "Waiting 15s for Gateway..."
sleep 15
echo "Running Cognitive E2E..."
npx tsx scripts/validate-behavior.ts
TEST_EXIT_CODE=$?
echo "Cleaning up Gateway (PID: $GATEWAY_PID)..."
kill -9 $GATEWAY_PID 2>/dev/null || true
exit $TEST_EXIT_CODE
