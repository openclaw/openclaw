#!/usr/bin/env bash
# Verifies the session data loss fix by running unit tests.
# The tests cover the gateway restart mid-turn scenario where a session file
# contains [header, user_msg] but no assistant message yet.
# Usage: bash scripts/verify-session-init-fix.sh

set -euo pipefail

echo "=== Running session-manager-init tests ==="
echo "Testing scenario: gateway restart mid-turn (user message present, no assistant)"
echo ""

pnpm vitest run src/agents/pi-embedded-runner/session-manager-init.test.ts

echo ""
echo "=== Verification complete ==="
echo "If the test 'should NOT reset when user message exists but no assistant' passes,"
echo "then the fix correctly preserves session data during gateway restarts."
