# Giao Thức WebSocket Gateway — OpenClaw UI

Mô tả cách UI giao tiếp với **OpenClaw Gateway** qua WebSocket.

---

## Tổng Quan

```
UI (Browser)         Gateway (Server)
     │                     │
     │  WebSocket open      │
     │─────────────────────>│
     │                     │
     │  event: connect.challenge  { nonce }
     │<─────────────────────│
     │                     │
     │  req: connect  { auth, device, ... }
     │─────────────────────>│
     │                     │
     │  res: hello-ok  { auth.deviceToken }
     │<─────────────────────│
     │                     │
     │  req: sessions.list  {}
     │─────────────────────>│
     │  res: { sessions: [...] }
     │<─────────────────────│
     │                     │
     │  event: session.updated
     │<─────────────────────│
```

---

## Frame Types

### Request Frame (UI → Gateway)

```json
{
  "type": "req",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "method": "sessions.list",
  "params": { "activeMinutes": 60, "limit": 100 }
}
```

### Response Frame (Gateway → UI)

```json
// Thành công:
{
  "type": "res",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ok": true,
  "payload": { "sessions": [...], "count": 5 }
}

// Lỗi:
{
  "type": "res",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ok": false,
  "error": { "code": "NOT_FOUND", "message": "Session not found" }
}
```

### Event Frame (Gateway → UI)

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "abc123" },
  "seq": 1,
  "stateVersion": { "presence": 5, "health": 3 }
}
```

---

## Gateway Methods (được dùng trong UI)

### Sessions

#### `sessions.list`

```ts
// Request params:
{
  activeMinutes?: number,   // Lọc session active trong N phút
  limit?: number,           // Giới hạn số lượng
  includeGlobal?: boolean,  // Bao gồm global sessions
  includeUnknown?: boolean  // Bao gồm unknown sessions
}

// Response payload:
{
  ts: number,
  path: string,
  count: number,
  defaults: GatewaySessionsDefaults,
  sessions: GatewaySessionRow[]
}
```

#### `sessions.patch`

```ts
// Request params:
{
  key: string,
  label?: string | null,
  thinkingLevel?: string | null,
  verboseLevel?: string | null,
  reasoningLevel?: string | null
}

// Response payload:
{
  ok: true,
  path: string,
  key: string,
  entry: { sessionId, updatedAt, thinkingLevel, ... }
}
```

#### `sessions.remove`

```ts
// Request params: { key: string }
// Response: { ok: true }
```

#### `sessions.reset`

```ts
// Request params: { reason: "new", key: string }
// Response: { sessionKey: string }
```

---

### Chat

#### `chat.history`

```ts
// Request params: { sessionKey: string }
// Response payload:
{
  sessionKey: string,
  messages: ChatMessage[]
}
```

#### `chat.send`

```ts
// Request params:
{
  sessionKey: string,
  message: string,
  idempotencyKey: string  // 20 bytes hex (random)
}

// Response payload:
{
  response?: string,
  error?: string
}
```

---

### Agents

#### `agents.list`

```ts
// Request params: {}
// Response payload:
{
  defaultId: string,
  mainKey: string,
  scope: string,
  agents: GatewayAgentRow[]
}
```

#### `agents.files.list`

```ts
// Request params: { agentId: string }
// Response payload:
{
  agentId: string,
  workspace: string,
  files: AgentFileEntry[]
}
```

---

### Channels

#### `channels.status`

```ts
// Request params: {}
// Response payload: ChannelsStatusSnapshot
// (toàn bộ trạng thái tất cả channels)
```

---

## `connect` Request — Auth Payload

```ts
{
  minProtocol: 3,
  maxProtocol: 3,
  client: {
    id: "openclaw-control-ui",
    version: "dev",
    platform: navigator.platform,
    mode: "webchat"
  },
  role: "operator",
  scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
  device: {
    id: string,         // deviceId (UUID)
    publicKey: string,  // Ed25519 public key (base64)
    signature: string,  // Ed25519 signature của payload
    signedAt: number,   // timestamp ms
    nonce: string       // từ connect.challenge
  },
  auth: {
    token?: string,
    password?: string
  },
  caps: [],
  userAgent: navigator.userAgent,
  locale: navigator.language
}
```

---

## `GatewaySessionRow` Type

```ts
type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
};
```

---

## Error Codes

| Code           | Ý nghĩa                                                       |
| -------------- | ------------------------------------------------------------- |
| `NOT_FOUND`    | Resource không tồn tại                                        |
| `UNAVAILABLE`  | Gateway unavailable (fallback khi không có error code cụ thể) |
| `UNAUTHORIZED` | Cần auth hoặc token không hợp lệ                              |
| `FORBIDDEN`    | Không có quyền                                                |

---

## Event Sequence Numbers

Gateway gửi `seq` trong mỗi event để phát hiện "gap" (event bị mất):

```ts
// Trong GatewayClient:
if (this.lastSeq !== null && seq > this.lastSeq + 1) {
  this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
}
this.lastSeq = seq;
```

`onGap` có thể được dùng để trigger reload data.

---

## Thêm Method Mới (Pattern)

```tsx
// Trong page component:
const myAction = useCallback(async () => {
  if (state !== "connected") return;

  try {
    const result = await request<MyResponseType>("my.method", {
      param1: "value",
      param2: 123,
    });
    // handle result
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed");
  }
}, [state, request]);
```
