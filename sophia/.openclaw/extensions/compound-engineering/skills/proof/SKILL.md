---
name: proof
description: Create, edit, comment on, and share markdown documents via Proof's web API and local bridge. Use when asked to "proof", "share a doc", "create a proof doc", "comment on a document", "suggest edits", "review in proof", or when given a proofeditor.ai URL.
allowed-tools:
  - Bash
  - Read
  - Write
  - WebFetch
---

# Proof - Collaborative Markdown Editor

Proof is a collaborative document editor for humans and agents. It supports two modes:

1. **Web API** - Create and edit shared documents via HTTP (no install needed)
2. **Local Bridge** - Drive the macOS Proof app via localhost:9847

## Web API (Primary for Sharing)

### Create a Shared Document

No authentication required. Returns a shareable URL with access token.

```bash
curl -X POST https://www.proofeditor.ai/share/markdown \
  -H "Content-Type: application/json" \
  -d '{"title":"My Doc","markdown":"# Hello\n\nContent here."}'
```

**Response format:**
```json
{
  "slug": "abc123",
  "tokenUrl": "https://www.proofeditor.ai/d/abc123?token=xxx",
  "accessToken": "xxx",
  "ownerSecret": "yyy",
  "_links": {
    "state": "https://www.proofeditor.ai/api/agent/abc123/state",
    "ops": "https://www.proofeditor.ai/api/agent/abc123/ops"
  }
}
```

Use the `tokenUrl` as the shareable link. The `_links` give you the exact API paths.

### Read a Shared Document

```bash
curl -s "https://www.proofeditor.ai/api/agent/{slug}/state" \
  -H "x-share-token: <token>"
```

### Edit a Shared Document

All operations go to `POST https://www.proofeditor.ai/api/agent/{slug}/ops`

**Note:** Use the `/api/agent/{slug}/ops` path (from `_links` in create response), NOT `/api/documents/{slug}/ops`.

**Authentication for protected docs:**
- Header: `x-share-token: <token>` or `Authorization: Bearer <token>`
- Token comes from the URL parameter: `?token=xxx` or the `accessToken` from create response

**Comment on text:**
```json
{"op": "comment.add", "quote": "text to comment on", "by": "ai:<agent-name>", "text": "Your comment here"}
```

**Reply to a comment:**
```json
{"op": "comment.reply", "markId": "<id>", "by": "ai:<agent-name>", "text": "Reply text"}
```

**Resolve a comment:**
```json
{"op": "comment.resolve", "markId": "<id>", "by": "ai:<agent-name>"}
```

**Suggest a replacement:**
```json
{"op": "suggestion.add", "kind": "replace", "quote": "original text", "by": "ai:<agent-name>", "content": "replacement text"}
```

**Suggest a deletion:**
```json
{"op": "suggestion.add", "kind": "delete", "quote": "text to delete", "by": "ai:<agent-name>"}
```

**Bulk rewrite:**
```json
{"op": "rewrite.apply", "content": "full new markdown", "by": "ai:<agent-name>"}
```

### Known Limitations (Web API)

- `suggestion.add` with `kind: "insert"` returns Bad Request on the web ops endpoint. Use `kind: "replace"` with a broader quote instead, or use `rewrite.apply` for insertions.
- Bridge-style endpoints (`/d/{slug}/bridge/*`) require client version headers (`x-proof-client-version`, `x-proof-client-build`, `x-proof-client-protocol`) and return 426 CLIENT_UPGRADE_REQUIRED without them. Use the `/api/agent/{slug}/ops` endpoint instead.

## Local Bridge (macOS App)

Requires Proof.app running. Bridge at `http://localhost:9847`.

**Required headers:**
- `X-Agent-Id: claude` (identity for presence)
- `Content-Type: application/json`
- `X-Window-Id: <uuid>` (when multiple docs open)

### Key Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/windows` | List open documents |
| GET | `/state` | Read markdown, cursor, word count |
| GET | `/marks` | List all suggestions and comments |
| POST | `/marks/suggest-replace` | `{"quote":"old","by":"ai:<agent-name>","content":"new"}` |
| POST | `/marks/suggest-insert` | `{"quote":"after this","by":"ai:<agent-name>","content":"insert"}` |
| POST | `/marks/suggest-delete` | `{"quote":"delete this","by":"ai:<agent-name>"}` |
| POST | `/marks/comment` | `{"quote":"text","by":"ai:<agent-name>","text":"comment"}` |
| POST | `/marks/reply` | `{"markId":"<id>","by":"ai:<agent-name>","text":"reply"}` |
| POST | `/marks/resolve` | `{"markId":"<id>","by":"ai:<agent-name>"}` |
| POST | `/marks/accept` | `{"markId":"<id>"}` |
| POST | `/marks/reject` | `{"markId":"<id>"}` |
| POST | `/rewrite` | `{"content":"full markdown","by":"ai:<agent-name>"}` |
| POST | `/presence` | `{"status":"reading","summary":"..."}` |
| GET | `/events/pending` | Poll for user actions |

### Presence Statuses

`thinking`, `reading`, `idle`, `acting`, `waiting`, `completed`

## Workflow: Review a Shared Document

When given a Proof URL like `https://www.proofeditor.ai/d/abc123?token=xxx`:

1. Extract the slug (`abc123`) and token from the URL
2. Read the document state via the API
3. Add comments or suggest edits using the ops endpoint
4. The author sees changes in real-time

```bash
# Read
curl -s "https://www.proofeditor.ai/api/agent/abc123/state" \
  -H "x-share-token: xxx"

# Comment
curl -X POST "https://www.proofeditor.ai/api/agent/abc123/ops" \
  -H "Content-Type: application/json" \
  -H "x-share-token: xxx" \
  -d '{"op":"comment.add","quote":"text","by":"ai:compound","text":"comment"}'

# Suggest edit
curl -X POST "https://www.proofeditor.ai/api/agent/abc123/ops" \
  -H "Content-Type: application/json" \
  -H "x-share-token: xxx" \
  -d '{"op":"suggestion.add","kind":"replace","quote":"old","by":"ai:compound","content":"new"}'
```

## Workflow: Create and Share a New Document

```bash
# 1. Create
RESPONSE=$(curl -s -X POST https://www.proofeditor.ai/share/markdown \
  -H "Content-Type: application/json" \
  -d '{"title":"My Doc","markdown":"# Title\n\nContent here."}')

# 2. Extract URL and token
URL=$(echo "$RESPONSE" | jq -r '.tokenUrl')
SLUG=$(echo "$RESPONSE" | jq -r '.slug')
TOKEN=$(echo "$RESPONSE" | jq -r '.accessToken')

# 3. Share the URL
echo "$URL"

# 4. Make edits using the ops endpoint
curl -X POST "https://www.proofeditor.ai/api/agent/$SLUG/ops" \
  -H "Content-Type: application/json" \
  -H "x-share-token: $TOKEN" \
  -d '{"op":"comment.add","quote":"Content here","by":"ai:compound","text":"Added a note"}'
```

## Safety

- Use `/state` content as source of truth before editing
- Prefer suggest-replace over full rewrite for small changes
- Don't span table cells in a single replace
- Always include `by` field for attribution tracking
