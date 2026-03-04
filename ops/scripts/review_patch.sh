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
  --message "Review the following git patch for correctness and relevance. Reply only APPROVE or REJECT.

$(cat "$PATCH_FILE")" \
  --json | jq -r '.result.payloads[0].text')

echo "[review_patch] reviewer decision: $REVIEW"

# Enforce reviewer decision
if [[ "$REVIEW" != "APPROVE" ]]; then
  echo "[review_patch] reviewer rejected patch"
  exit 1
fi

echo "[review_patch] reviewer approved patch"
exit 0
