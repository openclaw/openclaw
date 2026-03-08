# File Upload Protocol

OpenClaw supports two mechanisms for sending file attachments to agents over WebSocket:

1. **Inline attachments** — small files (< ~10 MB) sent as base64 inside `chat.send`
2. **Chunked uploads** — large files (any size) streamed via dedicated `file.*` methods

---

## 1. Inline Attachments (Small Files)

For files under ~10 MB, include them directly in the `chat.send` request as attachments. All MIME types are accepted — images, PDFs, documents, videos, audio, archives, etc.

### Request

```json
{
  "type": "req",
  "id": "msg-1",
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:main",
    "message": "Please analyze this document",
    "idempotencyKey": "unique-key-123",
    "attachments": [
      {
        "fileName": "report.pdf",
        "mimeType": "application/pdf",
        "content": "<base64-encoded-content>"
      },
      {
        "fileName": "photo.jpg",
        "mimeType": "image/jpeg",
        "content": "<base64-encoded-content>"
      }
    ]
  }
}
```

### Behavior

- **Image attachments** (`image/*`) are passed directly to the agent's vision pipeline — the agent sees the image natively.
- **Non-image attachments** (PDFs, documents, videos, etc.) are:
  1. Saved to `~/.openclaw/workspace/uploads/<filename>` on the server
  2. The agent receives a message with the file path and metadata:

     ```
     📎 File attached: `/home/user/.openclaw/workspace/uploads/report-a1b2c3d4.pdf` (type: application/pdf, size: 2.3MB)

     Please analyze this document
     ```

  3. The agent can then use file read tools or other processing to access the file.

### Size Limits

- Maximum decoded size per attachment: **10 MB** (configurable)
- Content must be valid base64
- Data URL prefixes (`data:mime/type;base64,...`) are automatically stripped

---

## 2. Chunked File Uploads (Large Files)

For files larger than ~10 MB (or any size), use the chunked upload protocol. This streams the file to the server in manageable pieces over the WebSocket connection.

### Protocol Flow

```
Client                              Server
  |                                    |
  |── file.chunk (chunk 0) ──────────>|
  |<── ack { chunksReceived: 1 } ─────|
  |                                    |
  |── file.chunk (chunk 1) ──────────>|
  |<── ack { chunksReceived: 2 } ─────|
  |                                    |
  |── ... more chunks ... ────────────>|
  |                                    |
  |── file.complete ─────────────────>|
  |                                    |── assembles file
  |                                    |── writes to disk
  |<── result { filePath, ... } ──────|
  |                                    |── broadcasts file.uploaded event
  |                                    |
```

### Step 1: Send Chunks

Send each chunk of the file as a separate `file.chunk` request:

```json
{
  "type": "req",
  "id": "chunk-0",
  "method": "file.chunk",
  "params": {
    "uploadId": "upload-abc123",
    "chunkIndex": 0,
    "totalChunks": 100,
    "data": "<base64-encoded-chunk>"
  }
}
```

**Parameters:**

| Field         | Type    | Description                                                   |
| ------------- | ------- | ------------------------------------------------------------- |
| `uploadId`    | string  | Unique identifier for this upload session                     |
| `chunkIndex`  | integer | Zero-based index of this chunk                                |
| `totalChunks` | integer | Total number of chunks (must be consistent across all chunks) |
| `data`        | string  | Base64-encoded chunk data                                     |

**Response:**

```json
{
  "type": "res",
  "id": "chunk-0",
  "ok": true,
  "payload": {
    "uploadId": "upload-abc123",
    "chunkIndex": 0,
    "chunksReceived": 1,
    "totalChunks": 100
  }
}
```

### Step 2: Complete Upload

After all chunks are sent successfully, finalize the upload:

```json
{
  "type": "req",
  "id": "complete-1",
  "method": "file.complete",
  "params": {
    "uploadId": "upload-abc123",
    "filename": "large-video.mp4",
    "mimeType": "video/mp4",
    "totalSize": 4500000000,
    "sessionKey": "agent:main:main"
  }
}
```

**Parameters:**

| Field        | Type    | Description                               |
| ------------ | ------- | ----------------------------------------- |
| `uploadId`   | string  | Must match the uploadId used in chunks    |
| `filename`   | string  | Original filename                         |
| `mimeType`   | string  | MIME type of the file                     |
| `totalSize`  | integer | Expected total file size in bytes         |
| `sessionKey` | string? | Optional session to notify about the file |

**Response:**

```json
{
  "type": "res",
  "id": "complete-1",
  "ok": true,
  "payload": {
    "uploadId": "upload-abc123",
    "filePath": "/home/user/.openclaw/workspace/uploads/large-video-a1b2c3d4.mp4",
    "filename": "large-video-a1b2c3d4.mp4",
    "mimeType": "video/mp4",
    "totalSize": 4500000000,
    "notification": "📎 File received: `/home/user/.openclaw/workspace/uploads/large-video-a1b2c3d4.mp4` (type: video/mp4, size: 4.2GB) — ready for processing"
  }
}
```

### Step 3 (Optional): Cancel Upload

To cancel an in-progress upload:

```json
{
  "type": "req",
  "id": "cancel-1",
  "method": "file.cancel",
  "params": {
    "uploadId": "upload-abc123"
  }
}
```

### Events

When a chunked upload completes, the server broadcasts a `file.uploaded` event to all connected clients:

```json
{
  "type": "evt",
  "event": "file.uploaded",
  "payload": {
    "uploadId": "upload-abc123",
    "filePath": "/home/user/.openclaw/workspace/uploads/large-video-a1b2c3d4.mp4",
    "filename": "large-video-a1b2c3d4.mp4",
    "mimeType": "video/mp4",
    "totalSize": 4500000000,
    "ts": 1709913600000
  }
}
```

---

## Limits & Constraints

| Constraint                            | Value                            |
| ------------------------------------- | -------------------------------- |
| Max inline attachment size            | 10 MB (decoded)                  |
| Max chunked file size                 | 10 GB                            |
| Max chunk size                        | 8 MB (base64 encoded)            |
| Max concurrent uploads per connection | 10                               |
| Upload timeout                        | 30 minutes                       |
| Uploads directory                     | `~/.openclaw/workspace/uploads/` |

## Filename Safety

- Path traversal attempts are sanitized (e.g., `../../../etc/passwd` → `etc_passwd`)
- Hidden files (starting with `.`) are stripped
- A random suffix is appended to prevent collisions
- Dangerous characters are replaced with underscores

## Connection Lifecycle

- In-progress uploads are automatically cleaned up when the WebSocket connection closes.
- Timed-out uploads (>30 minutes) are pruned on the next chunk/complete request.

## Recommended Chunk Size

We recommend ~4 MB chunks (base64-encoded, ~3 MB decoded). This balances:

- WebSocket frame size limits
- Memory usage on both client and server
- Progress granularity for UI feedback

## Client Implementation Example

```javascript
async function uploadFile(ws, file, sessionKey) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
  const uploadId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Send chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(await chunk.arrayBuffer())));

    const response = await sendRequest(ws, "file.chunk", {
      uploadId,
      chunkIndex: i,
      totalChunks,
      data: base64,
    });

    if (!response.ok) throw new Error(response.error.message);

    // Update progress: (i + 1) / totalChunks * 100
  }

  // Complete upload
  const result = await sendRequest(ws, "file.complete", {
    uploadId,
    filename: file.name,
    mimeType: file.type,
    totalSize: file.size,
    sessionKey,
  });

  return result.payload;
}
```
