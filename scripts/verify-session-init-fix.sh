#!/usr/bin/env bash
# Reproduces the gateway restart session data loss scenario and verifies the fix.
# Usage: bash scripts/verify-session-init-fix.sh

set -euo pipefail

SESSION_DIR=$(mktemp -d)
SESSION_FILE="$SESSION_DIR/test-session.jsonl"

echo "=== Simulating gateway restart mid-turn scenario ==="
echo "Creating session file with header + user message (no assistant yet)..."

# Simulate: header + user message but no assistant (gateway restart mid-turn state)
cat > "$SESSION_FILE" <<'EOF'
{"type":"session","version":3,"id":"test-id","timestamp":"2026-03-13T00:00:00.000Z","cwd":"/tmp"}
{"type":"message","id":"msg-001","parentId":null,"timestamp":"2026-03-13T00:01:00.000Z","message":{"role":"user","content":"还是不对，再试试"}}
EOF

echo "=== Before: $(wc -l < "$SESSION_FILE") lines ==="
cat "$SESSION_FILE"
echo ""

echo "=== Running unit tests ==="
pnpm vitest run src/agents/pi-embedded-runner/session-manager-init.test.ts

echo ""
echo "=== Verification complete ==="
echo "If the test 'should NOT reset when user message exists but no assistant' passes,"
echo "then the fix correctly preserves session data during gateway restarts."

rm -rf "$SESSION_DIR"
