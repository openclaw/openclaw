#!/usr/bin/env bash
# List your own LinkedIn posts
# Usage: my-posts.sh [account_id]
set -euo pipefail
ACCOUNT="${1:-}"

# Get person ID
PERSON_INFO=$(bash "$(dirname "$0")/call.sh" /me GET '{}' "$ACCOUNT")
PERSON_ID=$(echo "$PERSON_INFO" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['data']['id'])")

ENCODED_URN=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote('urn:li:person:' + sys.argv[1], safe=''))" "$PERSON_ID")

bash "$(dirname "$0")/call.sh" "/ugcPosts?q=authors&authors=List($ENCODED_URN)&sortBy=LAST_MODIFIED" GET '{}' "$ACCOUNT"
