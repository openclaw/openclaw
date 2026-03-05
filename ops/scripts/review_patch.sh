#!/usr/bin/env bash
set -euo pipefail

PATCH_FILE="$1"

echo "[review_patch] reviewing patch: $PATCH_FILE"

# Validate patch format and attempt to repair hunk counts
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  echo "[review_patch] INVALID PATCH"
  exit 1
fi

echo "[review_patch] patch format OK"

# Ask reviewer agent to evaluate the patch
REVIEW=$(openclaw-safe agent \
  --agent dir-architecture-01 \
  --timeout 120 \
  --thinking off \
  --message "Review the following git patch for correctness and relevance.

Reply in ONE of these formats:

APPROVE

or

REJECT: <brief explanation of what is wrong>

Patch:
$(cat "$PATCH_FILE")" \
  --json | jq -r '.result.payloads[0].text')

echo "[review_patch] reviewer response: $REVIEW"

if [[ "$REVIEW" == APPROVE* ]]; then
  echo "[review_patch] reviewer approved patch"
  exit 0
fi

echo "[review_patch] reviewer rejected patch"

echo "$REVIEW" > reviewer_feedback.txt

exit 1
