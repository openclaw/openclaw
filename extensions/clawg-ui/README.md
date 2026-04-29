# clawg-ui

![Banner](./clawgui.png)

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that exposes the gateway as an [AG-UI](https://docs.ag-ui.com) protocol-compatible HTTP endpoint. AG-UI clients such as [CopilotKit](https://www.copilotkit.ai) UIs and `@ag-ui/client` `HttpAgent` instances can connect to OpenClaw and receive streamed responses.

## Companion: `@contextableai/clawpilotkit`

If you want a ready-made chat UI that talks to this plugin, the
companion package [`@contextableai/clawpilotkit`](./clawpilotkit/) ships
the same prebuilt React + CopilotKit bundle in two modes:

- **Embedded** in the OpenClaw operator console as a `chat.surface`
  slot (renders inside the Chat tab in place of the built-in message
  thread + input box, no pairing needed).
- **Standalone** via `npx @contextableai/clawpilotkit` against any
  clawg-ui ≥ 0.7.0 gateway (the launcher walks the user through device
  pairing on first connect).

See [`clawpilotkit/README.md`](./clawpilotkit/) for setup. The rest of
this document covers the gateway-side plugin, which is what
clawpilotkit (and any other AG-UI client) talks to.

## Installation

```bash
npm install @contextableai/clawg-ui
```

Or with the OpenClaw plugin CLI:

```bash
openclaw plugins install @contextableai/clawg-ui
```

Then restart the gateway. The plugin auto-registers the `/v1/clawg-ui` endpoint and the `clawg-ui` channel.

## How it works

The plugin registers as an OpenClaw channel and adds an HTTP route at `/v1/clawg-ui`. When an AG-UI client POSTs a `RunAgentInput` payload, the plugin:

1. Authenticates the request using device pairing (see [Authentication](#authentication))
2. Parses the AG-UI messages into an OpenClaw inbound context
3. Routes to the appropriate agent via the gateway's standard routing
4. Dispatches the message through the reply pipeline (same path as Telegram, Teams, etc.)
5. Streams the agent's response back as AG-UI SSE events

```
AG-UI Client                        OpenClaw Gateway
    |                                      |
    |  POST /v1/clawg-ui (RunAgentInput)   |
    |------------------------------------->|
    |                                      |  Auth (device token)
    |                                      |  Route to agent
    |                                      |  Dispatch inbound message
    |                                      |
    |  SSE: RUN_STARTED                    |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_START             |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_CONTENT (delta)   |
    |<-------------------------------------|  (streamed chunks)
    |  SSE: TEXT_MESSAGE_CONTENT (delta)   |
    |<-------------------------------------|
    |  SSE: TOOL_CALL_START               |
    |<-------------------------------------|  (if agent uses tools)
    |  SSE: TOOL_CALL_ARGS                |
    |<-------------------------------------|
    |  SSE: TOOL_CALL_RESULT              |
    |<-------------------------------------|  (server tools only)
    |  SSE: TOOL_CALL_END                 |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_END              |
    |<-------------------------------------|
    |  SSE: RUN_FINISHED                  |
    |<-------------------------------------|
```

## Usage

### Prerequisites

- OpenClaw gateway running (`openclaw gateway run`)
- A paired device token (see [Authentication](#authentication))

### curl

```bash
# Using your device token (obtained through pairing)
curl -N -X POST http://localhost:18789/v1/clawg-ui \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer $CLAWG_UI_DEVICE_TOKEN" \
  -d '{
    "threadId": "thread-1",
    "runId": "run-1",
    "messages": [
      {"role": "user", "content": "What is the weather in San Francisco?"}
    ]
  }'
```

### @ag-ui/client HttpAgent

```typescript
import { HttpAgent } from "@ag-ui/client";

// Device token obtained through the pairing flow
const deviceToken = process.env.CLAWG_UI_DEVICE_TOKEN;

const agent = new HttpAgent({
  url: "http://localhost:18789/v1/clawg-ui",
  headers: {
    Authorization: `Bearer ${deviceToken}`,
  },
});

const stream = agent.run({
  threadId: "thread-1",
  runId: "run-1",
  messages: [
    { role: "user", content: "Hello from CLAWG-UI" },
  ],
});

for await (const event of stream) {
  console.log(event.type, event);
}
```

### CopilotKit

```tsx
import { CopilotKit } from "@copilotkit/react-core";

// Device token obtained through the pairing flow
const deviceToken = process.env.CLAWG_UI_DEVICE_TOKEN;

function App() {
  return (
    <CopilotKit
      runtimeUrl="http://localhost:18789/v1/clawg-ui"
      headers={{
        Authorization: `Bearer ${deviceToken}`,
      }}
    >
      {/* your app */}
    </CopilotKit>
  );
}
```

## Request format

The endpoint accepts a POST with a JSON body matching the AG-UI `RunAgentInput` schema:

| Field | Type | Required | Description |
|---|---|---|---|
| `threadId` | string | no | Conversation thread ID. Auto-generated if omitted. |
| `runId` | string | no | Unique run ID. Auto-generated if omitted. |
| `messages` | Message[] | yes | Array of messages. May be empty (returns an empty run). For agent execution, at least one `user` or `tool` message should be present. |
| `tools` | Tool[] | no | Client-side tool definitions. The agent can invoke these; see [Tool call events](#tool-call-events). |
| `state` | object | no | Client state (reserved for future use). |

### Message format

```json
{
  "role": "user",
  "content": "Hello"
}
```

Supported roles: `user`, `assistant`, `system`, `tool`.

## Response format

The response is an SSE stream. Each event is a `data:` line containing a JSON object with a `type` field from the AG-UI `EventType` enum:

| Event | When |
|---|---|
| `RUN_STARTED` | Immediately after validation |
| `TEXT_MESSAGE_START` | First assistant text chunk |
| `TEXT_MESSAGE_CONTENT` | Each streamed text delta |
| `TEXT_MESSAGE_END` | After last text chunk |
| `TOOL_CALL_START` | Agent invokes a tool |
| `TOOL_CALL_ARGS` | Tool call arguments (JSON delta) |
| `TOOL_CALL_RESULT` | Server-side tool execution result |
| `TOOL_CALL_END` | Tool call complete |
| `RUN_FINISHED` | Agent run complete |
| `RUN_ERROR` | On failure |

### Tool call events

Tool call events (`TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_RESULT`, `TOOL_CALL_END`) are emitted when the OpenClaw agent invokes a tool during its run. They are emitted via OpenClaw lifecycle hooks (`before_tool_call` and `tool_result_persist`) in `index.ts`.

**When do tool events appear?**

- The agent must have tools available (server-side tools on the agent, or client-side tools passed via the `tools` field)
- The agent's LLM must decide to call a tool based on the conversation

**Client tools vs server tools:**

- **Client tools** (passed via `tools` in the request): the stream emits `TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END`, then the run finishes. The client executes the tool locally and starts a new run with the result as a `tool` message.
- **Server tools** (registered on the OpenClaw agent): the stream emits `TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_RESULT` → `TOOL_CALL_END`. The agent continues processing in the same or a subsequent run.

> **Tip:** To confirm tool calls are being triggered, check the gateway logs for `[clawg-ui] before_tool_call:` entries.

## Authentication

clawg-ui uses **device pairing** to authenticate clients. This provides secure, per-device access control without exposing the gateway's master token.

### Device Pairing Flow

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  Gateway Owner  │      │  OpenClaw Server │      │   AG-UI Client  │
└────────┬────────┘      └────────┬─────────┘      └────────┬────────┘
         │                        │                         │
         │                        │  1. POST (no auth)      │
         │                        │<────────────────────────│
         │                        │                         │
         │                        │  2. Return device token │
         │                        │     + pairing code      │
         │                        │────────────────────────>│
         │                        │     403 pairing_pending │
         │                        │     { pairingCode, token }
         │                        │                         │
         │              3. Share pairing code (out of band) │
         │<─────────────────────────────────────────────────│
         │                        │                         │
    4. Approve device             │                         │
         │  openclaw pairing approve clawg-ui ABCD1234      │
         │───────────────────────>│                         │
         │                        │                         │
         │                        │  5. POST with device token
         │                        │<────────────────────────│
         │                        │     Authorization: Bearer <token>
         │                        │                         │
         │                        │  6. Success - SSE stream│
         │                        │────────────────────────>│
         │                        │                         │
```

### Step-by-Step Setup

#### 1. Client initiates pairing

The client sends a POST request without any authorization header:

```bash
curl -X POST http://localhost:18789/v1/clawg-ui \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response (403):

```json
{
  "error": {
    "type": "pairing_pending",
    "message": "Device pending approval",
    "pairing": {
      "pairingCode": "ABCD1234",
      "token": "MmRlOTA0ODIt...b71d",
      "instructions": "Save this token for use as a Bearer token and ask the owner to approve: openclaw pairing approve clawg-ui ABCD1234"
    }
  }
}
```

The client must save the `token` for future requests.

#### 2. Approve the device (gateway owner)

The client shares the `pairingCode` with the gateway owner, who approves it:

```bash
# List pending pairing requests
openclaw pairing list clawg-ui

# Approve the device
openclaw pairing approve clawg-ui ABCD1234
```

#### 3. Client uses Bearer token

Once approved, the client uses their Bearer token for all requests:

```bash
curl -N -X POST http://localhost:18789/v1/clawg-ui \
  -H "Authorization: Bearer MmRlOTA0ODIt...b71d" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `openclaw clawg-ui devices` | List approved devices |
| `openclaw pairing list clawg-ui` | List pending pairing requests awaiting approval |
| `openclaw pairing approve clawg-ui <code>` | Approve a device by its pairing code |

### Error Responses

| Status | Type | Meaning |
|--------|------|---------|
| 401 | `unauthorized` | Invalid device token |
| 403 | `pairing_pending` | No auth (initiates pairing) or valid token but device not yet approved |

### Deprecated: Direct Bearer Token

> **Deprecated:** Previous versions (0.1.x) allowed using the gateway's master token (`OPENCLAW_GATEWAY_TOKEN`) directly. This approach is **no longer supported**. All clients must now use device pairing.
>
> Old (deprecated):
> ```
> Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN
> ```
>
> New (required):
> ```
> POST without Authorization header  # Initiates pairing
> Authorization: Bearer <device-token>  # After approval
> ```

## Agent routing

The plugin uses OpenClaw's standard agent routing. By default, messages route to the `main` agent. To target a specific agent, set the `X-OpenClaw-Agent-Id` header:

```bash
curl -N -X POST http://localhost:18789/v1/clawg-ui \
  -H "Authorization: Bearer $CLAWG_UI_DEVICE_TOKEN" \
  -H "X-OpenClaw-Agent-Id: my-agent" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

## Session isolation

By default, sessions are keyed by `route.sessionKey` plus a `:thread:<threadId>` suffix so each thread gets its own session within the device. For multi-user applications where each user needs isolated conversation history within a shared AG-UI client, pass the `X-OpenClaw-Session-Key` header to add a `:user:<value>` scope on top:

```bash
curl -N -X POST http://localhost:18789/v1/clawg-ui \
  -H "Authorization: Bearer $CLAWG_UI_DEVICE_TOKEN" \
  -H "X-OpenClaw-Session-Key: user@example.com" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

This is useful when:
- Multiple authenticated users share the same AG-UI client (e.g., a web app with auth)
- You want to key sessions by user identity *in addition to* thread ID
- CopilotKit or other AG-UI clients manage `threadId` internally

### How the final session key is composed

The header **scopes** the route-derived key; it does not replace it:

```
<route.sessionKey>[:user:<header>][:thread:<threadId>]
```

With no header, the session key is `<route.sessionKey>:thread:<threadId>` (existing behaviour). With the header set to `alice@example.com` and `threadId: "t-1"`, it becomes `<route.sessionKey>:user:alice@example.com:thread:t-1`. The header can only subdivide an existing route scope — it cannot escape it.

### Trust model — treat this header like `X-Forwarded-For`

`X-OpenClaw-Session-Key` is a **trusted-proxy-only** concern, in the same family as `X-Forwarded-For` and `X-Request-ID`. It is expected to be set by a reverse proxy or authentication middleware that has already authenticated the user — not by end clients.

Deployments that are reachable by untrusted clients **must strip or overwrite this header at the ingress edge** before forwarding to the gateway. If an end client can set this header freely, they can impersonate any other user's session scope for that same device.

### Validation

The header value must match these rules; invalid values return `HTTP 400 invalid_request_error` and the agent is not dispatched:

- 1–256 characters after trimming
- Characters restricted to `[A-Za-z0-9._@:-]` (covers emails, UUIDs, and colon-separated identifiers)
- No path-traversal sequences: rejects `..` as a substring, slashes (`/`, `\`), and null bytes

## Error responses

Non-streaming errors return JSON:

| Status | Type | Meaning |
|---|---|---|
| 400 | `invalid_request_error` | Invalid request (missing messages, bad JSON) |
| 401 | `unauthorized` | Invalid device token |
| 403 | `pairing_pending` | No auth header (initiates pairing) or valid token but device not yet approved |
| 405 | — | Method not allowed (only POST accepted) |

Streaming errors emit a `RUN_ERROR` event and close the connection.

## Development

```bash
git clone https://github.com/contextablemark/clawg-ui
cd clawg-ui
npm install
npm test
```

## License

MIT
