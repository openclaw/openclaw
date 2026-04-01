#!/usr/bin/env bash
set -euo pipefail

# Load Shopify credentials
cd /home/kingler/openclaw-mabos
export $(grep '^SHOPIFY_STORE=' .env)
export $(grep '^SHOPIFY_ACCESS_TOKEN=' .env)

RESIZED_DIR="extensions/mabos/assets/hero-banners/resized"
MANIFEST="extensions/mabos/assets/hero-banners/upload-manifest.json"
GRAPHQL_URL="https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json"

# Initialize manifest
echo '{}' > "$MANIFEST"

upload_banner() {
  local FILE_PATH="$1"
  local FILENAME=$(basename "$FILE_PATH")
  local CDN_FILENAME="vw-${FILENAME}"
  local FILE_SIZE=$(stat -c%s "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH")
  
  echo "  Uploading: $FILENAME (${FILE_SIZE} bytes)"
  
  # Step 1: Create staged upload
  STAGE_RESP=$(curl -s -X POST "$GRAPHQL_URL" \
    -H "Content-Type: application/json" \
    -H "X-Shopify-Access-Token: $SHOPIFY_ACCESS_TOKEN" \
    -d "{
      \"query\": \"mutation { stagedUploadsCreate(input: [{resource: FILE, filename: \\\"$CDN_FILENAME\\\", mimeType: \\\"image/png\\\", httpMethod: POST, fileSize: \\\"$FILE_SIZE\\\"}]) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }\"
    }")
  
  # Extract staged target URL and resourceUrl
  STAGED_URL=$(echo "$STAGE_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['stagedUploadsCreate']['stagedTargets'][0]['url'])" 2>/dev/null)
  RESOURCE_URL=$(echo "$STAGE_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['stagedUploadsCreate']['stagedTargets'][0]['resourceUrl'])" 2>/dev/null)
  
  if [ -z "$STAGED_URL" ] || [ "$STAGED_URL" = "None" ]; then
    echo "  FAILED: Could not get staged upload URL"
    echo "$STAGE_RESP" | python3 -m json.tool 2>/dev/null || echo "$STAGE_RESP"
    return 1
  fi
  
  # Extract parameters
  PARAMS=$(echo "$STAGE_RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
params = d['data']['stagedUploadsCreate']['stagedTargets'][0]['parameters']
for p in params:
    print(f\"-F '{p['name']}={p['value']}'\")
" 2>/dev/null)
  
  # Step 2: Upload to staged URL  
  CURL_CMD="curl -s -X POST '$STAGED_URL'"
  while IFS= read -r param; do
    CURL_CMD="$CURL_CMD $param"
  done <<< "$PARAMS"
  CURL_CMD="$CURL_CMD -F 'file=@$FILE_PATH;type=image/png'"
  
  UPLOAD_RESP=$(eval "$CURL_CMD")
  
  # Step 3: Create file in Shopify
  local ARTWORK_NAME=$(echo "$FILENAME" | sed 's/hero-banner-//;s/.png//;s/-/ /g')
  FILE_RESP=$(curl -s -X POST "$GRAPHQL_URL" \
    -H "Content-Type: application/json" \
    -H "X-Shopify-Access-Token: $SHOPIFY_ACCESS_TOKEN" \
    -d "{
      \"query\": \"mutation { fileCreate(files: [{alt: \\\"VividWalls hero banner - $ARTWORK_NAME\\\", contentType: IMAGE, originalSource: \\\"$RESOURCE_URL\\\"}]) { files { ... on MediaImage { id image { url } } } userErrors { field message } } }\"
    }")
  
  CDN_URL=$(echo "$FILE_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['fileCreate']['files'][0]['image']['url'])" 2>/dev/null)
  FILE_ID=$(echo "$FILE_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['fileCreate']['files'][0]['id'])" 2>/dev/null)
  
  if [ -n "$CDN_URL" ] && [ "$CDN_URL" != "None" ]; then
    echo "  SUCCESS: $CDN_URL"
    # Update manifest
    python3 -c "
import json
m = json.load(open('$MANIFEST'))
m['$(echo $FILENAME | sed 's/.png//')'] = {'cdnUrl': '$CDN_URL', 'fileId': '$FILE_ID', 'filename': '$CDN_FILENAME'}
json.dump(m, open('$MANIFEST', 'w'), indent=2)
"
    return 0
  else
    echo "  FAILED: Could not get CDN URL"
    echo "$FILE_RESP" | python3 -m json.tool 2>/dev/null || echo "$FILE_RESP"
    return 1
  fi
}

echo '═══════════════════════════════════════════════════════════'
echo '  VividWalls Hero Banner Upload to Shopify CDN'
echo '═══════════════════════════════════════════════════════════'

SUCCESS=0
FAILED=0
TOTAL=0

for banner in "$RESIZED_DIR"/hero-banner-*.png; do
  TOTAL=$((TOTAL + 1))
  FNAME=$(basename "$banner" .png)
  
  # Check if already in manifest
  if python3 -c "import json; m=json.load(open('$MANIFEST')); assert '$FNAME' in m" 2>/dev/null; then
    echo "  SKIP: $FNAME (already uploaded)"
    SUCCESS=$((SUCCESS + 1))
    continue
  fi
  
  echo "──────────────────────────────────────────────────────────"
  echo "  [$TOTAL/48] $FNAME"
  
  if upload_banner "$banner"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
  
  sleep 1
done

echo ''
echo '═══════════════════════════════════════════════════════════'
echo "  Upload Complete"
echo "  Success: $SUCCESS"
echo "  Failed:  $FAILED"
echo "  Total:   $TOTAL"
echo '═══════════════════════════════════════════════════════════'
