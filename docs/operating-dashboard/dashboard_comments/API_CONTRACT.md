# Dashboard Comments API Contract

This contract is the production HTTP surface for the MoClaw operating dashboard comment overlay.

The frontend already works with `LocalCommentStore` for static file review. Production should expose the same data shape through maxx.center and switch the store to HTTP without changing the dashboard renderer.

## Auth

- Browser requests send `credentials: "include"`.
- Backend uses the existing maxx.center session.
- Backend returns only threads the current user can read.
- Backend writes `authorId`, `authorName`, and timestamps from the session/server, not from client input.

## Anchor

Comments attach to semantic anchors, not pixels.

```json
{
  "pageKey": "moclaw_operating_dashboard",
  "pageVersion": "v1",
  "sheetKey": "user_acquisition",
  "sheetTitle": "用户获取",
  "sectionKey": "paid_media",
  "sectionTitle": "投放",
  "rowKey": "ad_spend",
  "rowLabel": "广告花费",
  "columnKey": "col-1-05-15",
  "columnLabel": "05-15",
  "anchorType": "cell"
}
```

Valid `anchorType` values:

- `sheet`
- `section`
- `row`
- `cell`

## Thread Object

```json
{
  "id": "thread_01HX...",
  "pageKey": "moclaw_operating_dashboard",
  "pageVersion": "v1",
  "anchor": {
    "pageKey": "moclaw_operating_dashboard",
    "pageVersion": "v1",
    "sheetKey": "user_acquisition",
    "sheetTitle": "用户获取",
    "sectionKey": "paid_media",
    "sectionTitle": "投放",
    "rowKey": "ad_spend",
    "rowLabel": "广告花费",
    "columnKey": "col-1-05-15",
    "columnLabel": "05-15",
    "anchorType": "cell"
  },
  "status": "open",
  "createdAt": "2026-05-25T09:30:00.000Z",
  "updatedAt": "2026-05-25T09:30:00.000Z",
  "messages": [
    {
      "id": "msg_01HX...",
      "body": "这里需要确认口径。",
      "authorId": "user_123",
      "authorName": "Yee",
      "createdAt": "2026-05-25T09:30:00.000Z"
    }
  ]
}
```

Valid `status` values:

- `open`
- `resolved`

## Endpoints

### List Threads

```http
GET /api/dashboard-comments/threads?pageKey=moclaw_operating_dashboard&pageVersion=v1
```

Response:

```json
{
  "threads": []
}
```

### Create Thread

```http
POST /api/dashboard-comments/threads
Content-Type: application/json
```

Request:

```json
{
  "pageKey": "moclaw_operating_dashboard",
  "pageVersion": "v1",
  "anchor": {},
  "body": "这里需要确认口径。"
}
```

Response: the created thread.

### Add Message

```http
POST /api/dashboard-comments/threads/:threadId/messages
Content-Type: application/json
```

Request:

```json
{
  "body": "已确认。"
}
```

Response: the updated thread.

### Resolve Thread

```http
PATCH /api/dashboard-comments/threads/:threadId
Content-Type: application/json
```

Request:

```json
{
  "status": "resolved"
}
```

Response: the updated thread.

## Validation

Backend should reject:

- missing `pageKey` or `pageVersion`
- invalid `anchorType`
- missing required anchor keys for the anchor type
- empty `body`
- threads outside the current user's permission scope

Use `400` for invalid input, `401` for unauthenticated users, `403` for unauthorized access, and `404` for missing threads.
