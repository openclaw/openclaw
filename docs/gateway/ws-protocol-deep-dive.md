# OpenClaw Gateway WebSocket Protocol — Deep Dive

> Source-verified from `~/Development/openclaw/` and `~/Development/openclaw-tui/`
> Date: 2026-02-22

---

## Auth Handshake

### 1. `connect.challenge` event

Sent by the gateway **immediately** on WS connection open, before any client message.

**File:** `src/gateway/server/ws-connection.ts:162-167`

```ts
const connectNonce = randomUUID();
send({
  type: "event",
  event: "connect.challenge",
  payload: { nonce: connectNonce, ts: Date.now() },
});
```

**Payload:** `{ nonce: string (UUID), ts: number (Unix ms) }`

### 2. What to do with the nonce

The nonce must be **signed** as part of a device auth payload and sent back in `connect` params under `device.nonce`. It's included in a payload string that gets Ed25519-signed by the device's private key.

**File:** `src/gateway/server/ws-connection/message-handler.ts:544-550`

```ts
const nonceRequired = !isLocalClient;
const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
if (nonceRequired && !providedNonce) {
  rejectDeviceAuthInvalid("device-nonce-missing", "device nonce required");
}
if (providedNonce && providedNonce !== connectNonce) {
  rejectDeviceAuthInvalid("device-nonce-mismatch", "device nonce mismatch");
}
```

**For local connections:** nonce is optional. For remote connections: **required**.

**For a web HUD without device keys:** You can skip device auth entirely and use token/password auth. The nonce is only validated if `device` is present in connect params. If connecting from localhost with just a token, you can ignore the nonce completely.

**TUI behavior** (`ws_client.py:254-256`): Stores the nonce from the challenge event, includes it in the device signature payload.

### 3. `connect` request params — exact shape

**File:** `src/gateway/protocol/schema/frames.ts:20-67`

```ts
{
  minProtocol: integer (required, minimum 1),
  maxProtocol: integer (required, minimum 1),
  client: {                    // required
    id: string (required),     // e.g. "gateway-client", "control-ui", "webchat"
    displayName?: string,
    version: string (required),
    platform: string (required),
    deviceFamily?: string,
    modelIdentifier?: string,
    mode: string (required),   // "ui" | "cli" | "node" | "webchat"
    instanceId?: string,
  },
  caps?: string[],             // e.g. ["tool-events"]
  commands?: string[],
  permissions?: Record<string, boolean>,
  pathEnv?: string,
  role?: string,               // default "operator"; parsed values: "operator" | "node"
  scopes?: string[],           // e.g. ["operator.admin"]
  device?: {                   // optional — for device key auth
    id: string,
    publicKey: string,
    signature: string,
    signedAt: integer,
    nonce?: string,
  },
  auth?: {                     // optional — token/password auth
    token?: string,
    password?: string,
  },
  locale?: string,
  userAgent?: string,
}
```

**For a web HUD**, minimal connect:

```json
{
  "minProtocol": 3,
  "maxProtocol": 3,
  "client": {
    "id": "webchat",
    "displayName": "Web HUD",
    "version": "0.1.0",
    "platform": "web",
    "mode": "webchat"
  },
  "auth": { "token": "<gateway-token>" },
  "role": "operator",
  "scopes": ["operator.admin"]
}
```

**⚠️ Important:** When `client.mode` is `"webchat"`, the gateway applies webchat-specific restrictions — e.g. `sessions.patch` and `sessions.delete` are **blocked**. Use `"ui"` mode to avoid these restrictions.

**⚠️ Scopes:** Without a device identity, scopes are **cleared** by the gateway (set to empty) unless the connection is local or uses `controlUi.allowInsecureAuth`. A web HUD without device keys connecting remotely will have **no scopes** even if it declares them.

### 4. `hello-ok` response

**File:** `src/gateway/server/ws-connection/message-handler.ts:861-897`

Sent as `{ type: "res", id: <connect-request-id>, ok: true, payload: <hello-ok> }`.

```ts
{
  type: "hello-ok",
  protocol: 3,                 // negotiated protocol version
  server: {
    version: string,           // e.g. "1.2.3"
    commit?: string,
    host?: string,             // hostname
    connId: string,            // unique connection ID
  },
  features: {
    methods: string[],         // all available RPC methods
    events: string[],          // all event types client may receive
  },
  snapshot: Snapshot,           // current gateway state (sessions, presence, health, agents, etc.)
  canvasHostUrl?: string,
  auth?: {
    deviceToken: string,
    role: string,
    scopes: string[],
    issuedAtMs?: number,
  },
  policy: {
    maxPayload: 26214400,      // 25 MB
    maxBufferedBytes: 52428800, // 50 MB
    tickIntervalMs: 30000,     // 30 seconds
  },
}
```

### 5. Auth failure shape

Error response: `{ type: "res", id: <id>, ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized: ...", details?: ..., retryable?: boolean, retryAfterMs?: number } }`

Connection is closed with code `1008` after sending the error.

**Error codes used:** `INVALID_REQUEST` for most auth failures, `NOT_PAIRED` for device pairing requirements.

### 6. Protocol version

**`PROTOCOL_VERSION = 3`** — confirmed.

**File:** `src/gateway/protocol/schema/protocol-schemas.ts:267`

The gateway checks `maxProtocol >= 3 && minProtocol <= 3`. Only exact version 3 is supported.

---

## chat.send

### 7. Exact params

**File:** `src/gateway/protocol/schema/logs-chat.ts:28-40`

```ts
{
  sessionKey: string,          // required
  message: string,             // required (can be empty if attachments provided)
  thinking?: string,           // optional — prepended as `/think <thinking> <message>`
  deliver?: boolean,           // optional
  attachments?: unknown[],     // optional — array of attachment objects
  timeoutMs?: integer,         // optional — override agent timeout
  idempotencyKey: string,      // required (NonEmptyString)
}
```

### 8. Immediate response

**File:** `src/gateway/server-methods/chat.ts` (around line 460)

The `chat.send` handler responds **immediately** with:

```json
{
  "type": "res",
  "id": "<req-id>",
  "ok": true,
  "payload": { "runId": "<idempotencyKey>", "status": "started" }
}
```

**Yes, `runId` = `idempotencyKey`.** The client's idempotencyKey IS the runId.

If the idempotencyKey is already cached (completed run): returns the cached result with `{ cached: true }`.

If the idempotencyKey is in-flight: returns `{ runId: "<key>", status: "in_flight", cached: true }`.

### 9. Session already running

No automatic abort. Each `chat.send` with a unique `idempotencyKey` creates a **new** run. Multiple runs can be in-flight simultaneously for the same session.

However, if the message text matches a "stop command" pattern, it aborts all active runs for that session instead of starting a new one.

### 10. idempotencyKey

- Used as the `runId` for the chat run
- Cached after completion — resending the same key returns the cached result
- If a request with the same key is already in-flight, returns `status: "in_flight"` immediately
- Also used when persisting to transcript to prevent duplicate writes

---

## Chat Events (streaming)

### 11. Deltas are **REPLACING** (full accumulated text)

**File:** `src/gateway/server-chat.ts:280-310`

The agent's assistant stream emits `evt.data.text` which is the **full accumulated text so far**. Each delta contains the complete text up to that point, not just the new chunk.

```ts
chatRunState.buffers.set(clientRunId, text); // stores full text
// ...
message: {
  role: "assistant",
  content: [{ type: "text", text }],  // text = full accumulated text
  timestamp: now,
},
```

**Rate-limited:** Deltas are throttled to at most one every 150ms. Intermediate text is stored in the buffer but not broadcast.

### 12. Payload shapes per state

**Schema:** `src/gateway/protocol/schema/logs-chat.ts:60-76`

All chat events arrive as: `{ type: "event", event: "chat", payload: <ChatEvent> }`

**ChatEvent base:**

```ts
{
  runId: string,
  sessionKey: string,
  seq: integer (>= 0),
  state: "delta" | "final" | "aborted" | "error",
  message?: object,          // present for delta/final
  errorMessage?: string,     // present for error
  usage?: object,            // optional
  stopReason?: string,       // optional
}
```

**`delta`:**

```json
{
  "runId": "...",
  "sessionKey": "...",
  "seq": 5,
  "state": "delta",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "full accumulated text so far" }],
    "timestamp": 1740000000000
  }
}
```

**`final`:**

```json
{
  "runId": "...",
  "sessionKey": "...",
  "seq": 10,
  "state": "final",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "complete response" }],
    "timestamp": 1740000000000
  }
}
```

Note: `message` can be `undefined` if the response was empty/silent.

**`error`:**

```json
{
  "runId": "...",
  "sessionKey": "...",
  "seq": 10,
  "state": "error",
  "errorMessage": "stringified error"
}
```

**`aborted`:**

```json
{
  "runId": "...",
  "sessionKey": "...",
  "seq": 10,
  "state": "aborted",
  "stopReason": "rpc"
}
```

(Generated by `chat-abort.ts` — broadcasts with `state: "aborted"`)

### 13. Error state contents

`errorMessage` field — a stringified error. No structured error code within the chat event itself.

### 14. Broadcast scope

**ALL connected WS clients** receive chat events. The `broadcast()` function iterates over ALL `clients` and sends to each (subject to scope filtering via `hasEventScope`).

**File:** `src/gateway/server-broadcast.ts:60-117`

### 15. Cross-origin chat events

**Yes.** Any run from any source (Discord, Telegram, CLI, another WS client) that goes through the gateway's agent dispatch will emit chat events to ALL connected WS clients. The broadcast is not filtered by originator.

---

## chat.history

### 16. Params

**File:** `src/gateway/protocol/schema/logs-chat.ts:22-27`

```ts
{
  sessionKey: string,          // required
  limit?: integer,             // optional, min 1, max 1000, default 200
}
```

No cursor/pagination — just limit. Returns the **last N** messages.

### 17. Response shape

```json
{
  "sessionKey": "agent:codex:main",
  "sessionId": "uuid-of-session",
  "messages": [ ... ],
  "thinkingLevel": "low",
  "verboseLevel": "off"
}
```

Each message in the array is a raw transcript entry (JSON lines from the session file), sanitized:

- `details`, `usage`, `cost` fields stripped
- Text fields truncated to 12,000 chars
- Image `data` fields replaced with `{ omitted: true, bytes: N }`
- `thinkingSignature` removed
- Messages exceeding 128KB replaced with placeholder
- Total response capped by `maxChatHistoryMessagesBytes`

### 18. Tool calls in history

**Yes, included.** The history returns raw transcript messages which include tool_use and tool_result content blocks. The sanitization only strips metadata fields, not content types. You'll see:

```json
{ "role": "assistant", "content": [{ "type": "tool_use", "id": "...", "name": "Read", "input": {...} }] }
{ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "...", "content": "..." }] }
```

---

## chat.abort

### 19. Params

**File:** `src/gateway/protocol/schema/logs-chat.ts:42-46`

```ts
{
  sessionKey: string,          // required
  runId?: string,              // optional — if omitted, aborts ALL runs for session
}
```

### 20. Response

```json
{ "ok": true, "aborted": true, "runIds": ["run-id-1"] }
```

**Yes, triggers an `aborted` chat event** — the abort controller fires, which causes the agent run to end, which emits a lifecycle `end`/`error` event. The `chat-abort.ts` broadcasts:

```ts
broadcast("chat", { runId, sessionKey, seq, state: "aborted", stopReason });
```

---

## sessions.list

### 21. Response shape

```json
{
  "ts": 1740000000000,
  "path": "/path/to/sessions.json",
  "count": 5,
  "defaults": { ... },
  "sessions": [
    {
      "key": "agent:codex:main",
      "kind": "acp",
      "label": "main",
      "displayName": "Main",
      "channel": "discord",
      "subject": null,
      "groupChannel": null,
      "space": null,
      "chatType": "direct",
      "origin": { ... },
      "updatedAt": 1740000000000,
      "sessionId": "uuid",
      "systemSent": true,
      "abortedLastRun": false,
      "thinkingLevel": "low",
      "verboseLevel": "off",
      "reasoningLevel": null,
      "elevatedLevel": null,
      "sendPolicy": null,
      "inputTokens": 1234,
      "outputTokens": 5678,
      "totalTokens": 6912,
      "totalTokensFresh": true,
      "responseUsage": null,
      "modelProvider": "anthropic",
      "model": "claude-opus-4-6",
      "contextTokens": null,
      "deliveryContext": null,
      "lastChannel": "discord",
      "lastTo": "user:123",
      "lastAccountId": null,
      "derivedTitle": null,
      "lastMessagePreview": null
    }
  ]
}
```

Includes: sessionKey (as `key`), sessionId, model/modelProvider, updatedAt, token counts, labels, etc.

**Params:** `{ limit?, activeMinutes?, includeGlobal?, includeUnknown?, includeDerivedTitles?, includeLastMessage?, label?, spawnedBy?, agentId?, search? }`

---

## Error Handling

### 22. Generic error response

```json
{
  "type": "res",
  "id": "<request-id>",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "human-readable error message",
    "details": null,
    "retryable": false,
    "retryAfterMs": null
  }
}
```

**Error codes:** `INVALID_REQUEST`, `UNAVAILABLE`, `NOT_LINKED`, `NOT_PAIRED`, `AGENT_TIMEOUT`

### 23. Invalid method name

Handled by `handleGatewayRequest` in `server-methods.ts`. If the method doesn't match any registered handler, returns:

```json
{ "ok": false, "error": { "code": "INVALID_REQUEST", "message": "unknown method: foo.bar" } }
```

### 24. Malformed request

If the frame doesn't validate as a `RequestFrame`:

```json
{
  "type": "res",
  "id": "invalid",
  "ok": false,
  "error": { "code": "INVALID_REQUEST", "message": "invalid request frame: ..." }
}
```

---

## Connection Lifecycle

### 25. Heartbeat/ping — Tick events

**File:** `src/gateway/server-maintenance.ts:58`

The gateway broadcasts a **`tick` event** every **30 seconds** (`TICK_INTERVAL_MS = 30_000`).

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1740000000000 }, "seq": 42 }
```

This serves as a heartbeat. There's also standard WebSocket ping/pong from the `ws` library.

### 26. In-flight requests on disconnect

Pending requests are **abandoned** server-side. The agent run continues but chat events have nowhere to go (the socket is gone). Active `chatAbortControllers` are **not** automatically cleaned up on disconnect — the runs continue until they complete or time out.

On the client side (TUI): all pending request futures are rejected with `RuntimeError("gateway disconnected: ...")`.

### 27. Session state change events

No dedicated session lifecycle events. The gateway broadcasts:

- `tick` (heartbeat with snapshot updates)
- `agent` events (agent lifecycle phases: start, end, error)
- `chat` events (delta, final, aborted, error)
- `device.pair.requested`, `device.pair.resolved`
- `voicewake.changed`
- `heartbeat` (agent heartbeat events)
- `shutdown` (gateway shutting down)

Session creation/deletion are not broadcast as events — clients must poll `sessions.list` or watch for `tick` events which include a `stateVersion`.

---

## Message Format

### 28. Send/receive asymmetry — CONFIRMED

**Send:** `chat.send` takes `message: string` (plain text)
**Receive:** Chat events and history return `content: [{type: "text", text: "..."}]` (content block array)

This asymmetry is correct and by design. The gateway converts the string input into a proper message format internally.

### 29. Tool calls in content array

Tool calls appear as standard Anthropic/OpenAI content blocks:

```json
// Assistant message with tool use:
{ "role": "assistant", "content": [
  { "type": "text", "text": "Let me read that file..." },
  { "type": "tool_use", "id": "toolu_123", "name": "Read", "input": { "path": "foo.ts" } }
]}

// Tool result (user role):
{ "role": "user", "content": [
  { "type": "tool_result", "tool_use_id": "toolu_123", "content": "file contents here" }
]}
```

These appear in `chat.history` responses. During streaming, **only the final accumulated assistant text** is sent via chat delta/final events — tool calls are sent separately via `agent` events (if the client has `tool-events` capability).

### 30. Timestamp format

**Unix milliseconds (number).** `Date.now()` throughout.

```ts
timestamp: Date.now(); // e.g. 1740000000000
```

Session entries use `updatedAt: number` (Unix ms). The `connect.challenge` payload also uses `ts: Date.now()`.

---

## Additional Discoveries

### Event Sequencing

All broadcast events include a monotonically increasing `seq` number (per gateway instance). The TUI client detects sequence gaps:

```python
if self._last_seq is not None and seq > (self._last_seq + 1) and self.on_gap is not None:
    self.on_gap({"expected": self._last_seq + 1, "received": seq})
```

Targeted events (sent to specific connIds only) have `seq: undefined`.

### `stateVersion` in events

Events can carry a `stateVersion` object for optimistic state sync:

```ts
{ type: "event", event: "...", payload: ..., seq: N, stateVersion?: { presence?: number, health?: number } }
```

### Slow Consumer Protection

If a client's socket `bufferedAmount` exceeds `MAX_BUFFERED_BYTES` (50MB):

- For `dropIfSlow: true` events (deltas, ticks): silently dropped
- For other events: connection is **closed** with code `1008 "slow consumer"`

### Delta Rate Limiting

Chat deltas are throttled to **one every 150ms**. The buffer always has the latest text, so no data is lost — just fewer intermediate frames.

### `chat.inject` method

Undocumented but useful: allows injecting an assistant message directly into a session transcript without running the agent. Could be used for system messages in the HUD.

```ts
{ sessionKey: string, message: string, label?: string }
```

### Webchat Client Restrictions

If `client.id === "webchat"` or mode detects webchat:

- `sessions.patch` — **blocked**
- `sessions.delete` — **blocked**
- Error: "webchat clients cannot patch/delete sessions"

Use `client.id: "control-ui"` and `mode: "ui"` to avoid these restrictions.

### Available Methods

The `hello-ok` response includes `features.methods` — the complete list of available RPC methods. Check this at runtime rather than hardcoding.

### Handshake Timeout

The gateway has a handshake timeout (configurable, default likely ~30s). If `connect` isn't completed within this window, the connection is closed.

### Origin Check for Browser Clients

If `client.id` is `"control-ui"` or `"webchat"`, the gateway checks the `Origin` header against `gateway.controlUi.allowedOrigins` config. For a web HUD served from a different origin, this must be configured.

### Max Payload

WebSocket max message size: **25 MB** (`MAX_PAYLOAD_BYTES`). Enforced by the `ws` library's `maxPayload` option.
