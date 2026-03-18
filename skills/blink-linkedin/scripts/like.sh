#!/usr/bin/env bash
# Like a LinkedIn post
# Usage: like.sh <post_urn> [account_id]
# Example: like.sh "urn:li:ugcPost:1234567890"
set -euo pipefail
POST_URN="${1:-}"
ACCOUNT="${2:-}"
[ -z "$POST_URN" ] && echo "Usage: like.sh <post_urn> [account_id]" && exit 1

# Get person ID
PERSON_INFO=$(bash "$(dirname "$0")/call.sh" /me GET '{}' "$ACCOUNT")
PERSON_ID=$(echo "$PERSON_INFO" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['data']['id'])")

ENCODED_URN=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$POST_URN")

PARAMS=$(python3 -c "
import json, sys
print(json.dumps({
  'actor': 'urn:li:person:' + sys.argv[1],
  'object': sys.argv[2]
}))
" "$PERSON_ID" "$POST_URN")

bash "$(dirname "$0")/call.sh" "rest/socialActions/$ENCODED_URN/likes" POST "$PARAMS" "$ACCOUNT"
