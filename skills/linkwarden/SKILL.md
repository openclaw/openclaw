---
name: linkwarden
description: "Save, browse, and organize bookmarks via the Linkwarden REST API. Use when: saving a URL to bookmarks, searching saved links, tagging links, organizing into collections, or listing recent saves. Requires LINKWARDEN_API_KEY and LINKWARDEN_URL. Self-hosted or cloud. NOT for: Raindrop.io, Pocket, Pinboard, or other bookmark managers."
homepage: https://linkwarden.app
metadata:
  {
    "openclaw":
      {
        "emoji": "🔖",
        "requires": { "env": ["LINKWARDEN_API_KEY", "LINKWARDEN_URL"] },
        "primaryEnv": "LINKWARDEN_API_KEY"
      }
  }
---

# Linkwarden Skill

Save and manage bookmarks using the Linkwarden REST API. Works with self-hosted or Linkwarden Cloud instances.

## Setup

1. Log in to your Linkwarden instance (self-hosted: `http://localhost:3000` or your domain; cloud: `https://app.linkwarden.app`)
2. Go to **Settings → Access Tokens** → Generate a token
3. Set environment variables:

```bash
export LINKWARDEN_URL="https://app.linkwarden.app"  # or your self-hosted URL
export LINKWARDEN_API_KEY="your_access_token_here"
```

---

## API Basics

```bash
HOST="$LINKWARDEN_URL"
KEY="$LINKWARDEN_API_KEY"

curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/api/v1/..."
```

---

## Common Operations

### Save a New Link

```bash
URL_TO_SAVE="https://example.com/article"
COLLECTION_ID=1  # Your collection ID (get from /api/v1/collections)

curl -s -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  "$HOST/api/v1/links" \
  -d "{
    \"url\": \"$URL_TO_SAVE\",
    \"name\": \"Example Article\",
    \"description\": \"An interesting read\",
    \"tags\": [{\"name\": \"reading\"}, {\"name\": \"tech\"}],
    \"collectionId\": $COLLECTION_ID
  }" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Saved: [{d[\"response\"][\"id\"]}] {d[\"response\"][\"name\"]}')"
```

### List Recent Bookmarks

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/api/v1/links?sort=0&cursor=0" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for link in data.get('response', [])[:10]:
    tags = ', '.join(t['name'] for t in link.get('tags', []))
    print(f'🔖 [{link[\"id\"]}] {link[\"name\"]}')
    print(f'   {link[\"url\"][:70]}')
    print(f'   Tags: {tags or \"none\"}')
    print()
"
```

### Search Bookmarks

```bash
QUERY="machine learning"
curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/api/v1/links?searchQueryString=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")" | \
  python3 -c "
import json, sys
for link in json.load(sys.stdin).get('response', []):
    print(f'🔖 {link[\"name\"]} — {link[\"url\"][:60]}')
"
```

### List Collections

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$HOST/api/v1/collections" | \
  python3 -c "
import json, sys
for col in json.load(sys.stdin).get('response', []):
    print(f'[{col[\"id\"]}] 📁 {col[\"name\"]} ({col.get(\"_count\",{}).get(\"links\",0)} links)')
"
```

### Create a New Collection

```bash
curl -s -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  "$HOST/api/v1/collections" \
  -d '{"name": "AI Tools", "description": "Useful AI resources", "isPublic": false}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin)['response']; print(f'Created collection [{d[\"id\"]}]: {d[\"name\"]}')"
```

### Delete a Link

```bash
LINK_ID=42
curl -s -X DELETE \
  -H "Authorization: Bearer $KEY" \
  "$HOST/api/v1/links/$LINK_ID"
echo "Deleted link $LINK_ID"
```

### Update a Link (Add Tags, Rename)

```bash
LINK_ID=42
curl -s -X PUT \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  "$HOST/api/v1/links/$LINK_ID" \
  -d '{
    "name": "Updated Article Title",
    "tags": [{"name": "must-read"}, {"name": "ai"}]
  }'
```

---

## Sort Options for Link Listing

| Value | Sort Order |
|---|---|
| `0` | Date added (newest first) |
| `1` | Date added (oldest first) |
| `2` | Name (A–Z) |
| `3` | Name (Z–A) |

---

## Notes

- Self-hosted default port is `3000`; cloud is `https://app.linkwarden.app`
- Linkwarden automatically captures snapshots (PDF/screenshot) when you save a link
- Collections can be public or private — set `isPublic: true` to share
- Tags are created on-the-fly in the link payload; no need to pre-create them
- Pagination uses `cursor` (integer offset): `?cursor=0&take=20` for pages
- Linkwarden source is at https://github.com/linkwarden/linkwarden
