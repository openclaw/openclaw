#!/usr/bin/env bash
# Add a comment to a LinkedIn post
# Usage: comment.sh <post_urn> <text> [account_id]
# Example: comment.sh "urn:li:ugcPost:1234567890" "Great post!"
set -euo pipefail
POST_URN="${1:-}"
TEXT="${2:-}"
ACCOUNT="${3:-}"
[ -z "$POST_URN" ] && echo "Usage: comment.sh <post_urn> <text> [account_id]" && exit 1
[ -z "$TEXT" ] && echo "Error: text is required" && exit 1

# Get person ID
PERSON_INFO=$(bash "$(dirname "$0")/call.sh" /me GET '{}' "$ACCOUNT")
PERSON_ID=$(echo "$PERSON_INFO" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['data']['id'])")

ENCODED_URN=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$POST_URN")

PARAMS=$(python3 -c "
import json, sys
print(json.dumps({
  'actor': 'urn:li:person:' + sys.argv[1],
  'object': sys.argv[2],
  'message': {'text': sys.argv[3]}
}))
" "$PERSON_ID" "$POST_URN" "$TEXT")

bash "$(dirname "$0")/call.sh" "rest/socialActions/$ENCODED_URN/comments" POST "$PARAMS" "$ACCOUNT"
