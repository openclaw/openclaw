#!/usr/bin/env bash
# Proof: Discord 413 Entity Too Large → text-only fallback (#99021)
#
# Runs the production sendMessageDiscord function through vitest with
# the 413 regression test.  The test mocks Discord's REST API to return
# HTTP 413 on the first attempt (media upload) and succeed on the second
# (text-only fallback).

set -eo pipefail
cd "$(dirname "$0")/../.."

echo "=== PROOF: Discord 413 → text-only fallback ==="
echo ""

node scripts/run-vitest.mjs run extensions/discord/src/send.sends-basic-channel-messages.test.ts \
  -t "sends text-only fallback when Discord rejects media with 413" \
  2>&1 | tail -20

test_status="${PIPESTATUS[0]}"
echo ""
if [ "$test_status" -eq 0 ]; then
  echo "Result: PASS - message text delivered despite 413 on media"
else
  echo "Result: FAIL - see test output above"
  exit "$test_status"
fi
