# Design Document: Telegram Userbot Channel

**Status:** Draft
**Date:** 2026-03-02
**Spec:** [spec.md](./spec.md)

---

## 1. Architecture Overview

The `telegram-userbot` channel is a **standalone ChannelPlugin** — same abstraction as telegram, discord, whatsapp, signal. It registers itself via the plugin system and implements all standard channel adapters.

```
┌──────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                       │
│                                                          │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │ telegram (bot)   │  │ telegram-userbot (MTProto)    │  │
│  │ ChannelPlugin    │  │ ChannelPlugin                 │  │
│  │                  │  │                               │  │
│  │ grammy/Bot API   │  │ GramJS/MTProto                │  │
│  │ Webhook inbound  │  │ Event-based inbound           │  │
│  │ Bot API outbound │  │ User API outbound             │  │
│  │                  │  │                               │  │
│  │ channels.telegram│  │ channels.telegram-userbot     │  │
│  └─────────────────┘  └──────────────────────────────┘  │
│          │                        │                      │
│          └───────┬────────────────┘                      │
│                  ▼                                        │
│         ┌──────────────┐                                 │
│         │ Agent Engine  │                                 │
│         │ (shared)      │                                 │
│         └──────────────┘                                 │
└──────────────────────────────────────────────────────────┘
```

Both channels coexist independently. Agent can use either via `message` tool's `channel` param.

---

## 2. ChannelPlugin Contract

The userbot must implement the standard `ChannelPlugin` interface:

```typescript
const telegramUserbotPlugin: ChannelPlugin = {
  id: "telegram-userbot",
  meta: {
    id: "telegram-userbot",
    label: "Telegram (User)",
    selectionLabel: "Telegram (User Account / MTProto)",
    detailLabel: "Telegram Userbot",
    docsPath: "/channels/telegram-userbot",
    docsLabel: "telegram-userbot",
    blurb: "Connect your own Telegram account via MTProto. Full user capabilities.",
    systemImage: "person.crop.circle",
  },

  // Adapters (see section 3)
  setup: telegramUserbotSetupAdapter,
  auth: telegramUserbotAuthAdapter,
  config: telegramUserbotConfigAdapter,
  outbound: telegramUserbotOutboundAdapter,
  messaging: telegramUserbotMessagingAdapter,
  status: telegramUserbotStatusAdapter,
  security: telegramUserbotSecurityAdapter,
  // Optional:
  streaming: telegramUserbotStreamingAdapter,
  threading: telegramUserbotThreadingAdapter,
  messageActions: telegramUserbotMessageActionsAdapter,
  directory: telegramUserbotDirectoryAdapter,
  agentPrompt: telegramUserbotAgentPromptAdapter,
};
```

---

## 3. Adapter Design

### 3.1 Setup Adapter (`ChannelSetupAdapter`)

Interactive setup flow for `openclaw channels add --channel telegram-userbot`:

```
Step 1: API credentials
  → Enter API ID (from my.telegram.org)
  → Enter API Hash

Step 2: Phone authentication
  → Enter phone number
  → Enter code from Telegram
  → Enter 2FA password (if enabled)

Step 3: Verify & save
  → Test connection: get self user info
  → Save session string to ~/.openclaw/credentials/telegram-userbot-{accountId}.session
  → Save apiId/apiHash to config
  → Display: "Connected as @username"
```

### 3.2 Outbound Adapter (`ChannelOutboundAdapter`)

Maps OpenClaw outbound actions to GramJS calls:

```typescript
interface OutboundAdapter {
  send(ctx: ChannelOutboundContext): Promise<SendResult>;
  // ctx includes: chatId, text, media, replyTo, buttons, etc.
}
```

**Mapping:**

| OpenClaw Action       | GramJS Method                                            |
| --------------------- | -------------------------------------------------------- |
| send text             | `client.sendMessage(peer, { message })`                  |
| send media (photo)    | `client.sendFile(peer, { file, forceDocument: false })`  |
| send media (document) | `client.sendFile(peer, { file, forceDocument: true })`   |
| send voice            | `client.sendFile(peer, { file, voiceNote: true })`       |
| reply                 | `client.sendMessage(peer, { message, replyTo })`         |
| edit                  | `client.editMessage(peer, { message: id, text })`        |
| delete                | `client.deleteMessages(peer, [id], { revoke: true })`    |
| react                 | `client.invoke(SendReaction(...))`                       |
| forward               | `client.forwardMessages(toPeer, { messages, fromPeer })` |
| pin                   | `client.pinMessage(peer, id)`                            |

### 3.3 Messaging Adapter (`ChannelMessagingAdapter`)

Handles inbound messages from MTProto event handler:

```typescript
// GramJS event → OpenClaw inbound message
client.addEventHandler(async (event) => {
  const message = event.message;
  // Convert to OpenClaw format:
  const inbound: InboundMessage = {
    channel: "telegram-userbot",
    chatId: resolveChatId(message),
    messageId: message.id,
    text: message.text,
    senderId: message.senderId,
    senderName: await resolveSenderName(message),
    // media, reply context, etc.
  };
  // Route to gateway for agent processing
  await gateway.handleInbound(inbound);
}, new NewMessage({}));
```

### 3.4 Message Actions Adapter (`ChannelMessageActionAdapter`)

Exposed via `message` tool:

```typescript
const SUPPORTED_ACTIONS = [
  "send", // Send message
  "delete", // Delete messages (own + others in DM)
  "edit", // Edit own messages
  "react", // React with any emoji
  "forward", // Forward messages
  "pin", // Pin/unpin
  "topic-create", // Create forum topics (if admin)
] as const;
```

### 3.5 Status Adapter (`ChannelStatusAdapter`)

For `openclaw status` and `openclaw channels status`:

```typescript
{
  connected: boolean;
  username: string;
  userId: number;
  uptime: number; // seconds
  reconnects: number;
  lastActivity: Date;
  dcId: number; // Telegram datacenter
  latencyMs: number;
}
```

### 3.6 Auth/Security Adapter

```typescript
// allowFrom works same as telegram bot:
// channels.telegram-userbot.allowFrom: [267619672]
//
// Session validation:
// - On connect: verify session still valid
// - On AUTH_KEY_UNREGISTERED: mark as disconnected, alert user
// - Session string never logged or exposed
```

### 3.7 Streaming Adapter (optional)

Real-time typing indicators via MTProto:

```typescript
// Show "typing..." to the other user
await client.invoke(
  new Api.messages.SetTyping({
    peer,
    action: new Api.SendMessageTypingAction(),
  }),
);
```

### 3.8 Directory Adapter

Resolve contacts and chats:

```typescript
// List dialogs (recent chats)
const dialogs = await client.getDialogs({ limit: 100 });

// Resolve username → peer
const entity = await client.getEntity("username");

// Search contacts
const result = await client.invoke(new Api.contacts.Search({ q: "name" }));
```

---

## 4. Module Structure

```
src/telegram-userbot/
├── index.ts                    # Plugin registration entry point
├── plugin.ts                   # ChannelPlugin definition + adapter wiring
├── client.ts                   # GramJS client wrapper (connect/disconnect/health)
├── session-store.ts            # Session string persistence (~/.openclaw/credentials/)
├── connection.ts               # Connection manager (reconnect, keepalive, health)
├── flood-control.ts            # Rate limiting, flood_wait handling
├── inbound.ts                  # MTProto event handler → OpenClaw inbound
├── outbound.ts                 # OpenClaw outbound → GramJS calls
├── adapters/
│   ├── setup.ts                # Interactive setup (phone + code auth)
│   ├── auth.ts                 # Auth/allowFrom adapter
│   ├── config.ts               # Config schema adapter
│   ├── status.ts               # Status/health adapter
│   ├── security.ts             # Security policy adapter
│   ├── streaming.ts            # Typing indicators
│   ├── threading.ts            # Topic/thread support
│   ├── directory.ts            # Contact/dialog resolution
│   ├── message-actions.ts      # delete/react/forward/pin actions
│   └── agent-prompt.ts         # Inbound context for agent
├── helpers.ts                  # Peer resolution, message conversion
├── types.ts                    # TypeScript types
└── normalize.ts                # Chat ID / peer normalization
```

---

## 5. Configuration Schema

```yaml
channels:
  telegram-userbot:
    # Required
    apiId: 14858133
    apiHash: "e2e99eeda6fadba49f549fefd36fd037"
    # sessionFile auto-managed

    # Access control (same pattern as telegram bot)
    allowFrom:
      - 267619672 # Ruslan's Telegram user ID

    # Optional
    rateLimit:
      messagesPerSecond: 20
      perChatPerSecond: 1
      jitterMs: [50, 200]

    reconnect:
      maxAttempts: -1 # infinite
      alertAfterFailures: 3

    # Capabilities toggle
    capabilities:
      deleteOtherMessages: true
      readHistory: true
      forceDocument: true # Always send files as documents
```

Zod schema:

```typescript
const telegramUserbotConfigSchema = z.object({
  apiId: z.number(),
  apiHash: z.string(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  rateLimit: z
    .object({
      messagesPerSecond: z.number().default(20),
      perChatPerSecond: z.number().default(1),
      jitterMs: z.tuple([z.number(), z.number()]).default([50, 200]),
    })
    .optional(),
  reconnect: z
    .object({
      maxAttempts: z.number().default(-1),
      alertAfterFailures: z.number().default(3),
    })
    .optional(),
  capabilities: z
    .object({
      deleteOtherMessages: z.boolean().default(true),
      readHistory: z.boolean().default(true),
      forceDocument: z.boolean().default(true),
    })
    .optional(),
});
```

---

## 6. Channel Registration

```typescript
// src/telegram-userbot/index.ts
import type { OpenClawPluginAPI } from "../plugins/types.js";
import { createTelegramUserbotPlugin } from "./plugin.js";

export default function register(api: OpenClawPluginAPI) {
  const plugin = createTelegramUserbotPlugin();
  api.registerChannel(plugin);
}
```

Must be added to the plugin loader:

- `src/plugins/loader.ts` or equivalent registration path
- Add `"telegram-userbot"` to `CHAT_CHANNEL_ORDER` in `src/channels/registry.ts`

---

## 7. Inbound Message Flow

```
Telegram servers
      │ (MTProto push)
      ▼
GramJS client (event handler)
      │
      ▼
inbound.ts: normalize event → InboundMessage
      │
      ▼
Gateway: handleInbound(channel="telegram-userbot", ...)
      │
      ▼
Agent session: process message
      │
      ▼
Agent reply → outbound.ts → GramJS → Telegram
```

### 7.1 Inbound Event Types

| Telegram Event | Handler                     |
| -------------- | --------------------------- |
| NewMessage     | Main message handler        |
| MessageEdited  | Edit notification           |
| CallbackQuery  | Inline button clicks        |
| MessageDeleted | Deletion notification       |
| UserTyping     | (optional) typing awareness |

### 7.2 Media Handling (Inbound)

```typescript
// Download media from MTProto → save to media dir
if (message.media) {
  const buffer = await client.downloadMedia(message.media);
  const filePath = saveToMediaDir(buffer, message.media);
  inbound.mediaPath = filePath;
  inbound.mimeType = resolveMimeType(message.media);
}
```

---

## 8. Outbound Message Flow

```
Agent reply
      │
      ▼
message tool (channel="telegram-userbot")
      │
      ▼
outbound.ts: resolve peer, prepare payload
      │
      ▼
flood-control.ts: acquire() — wait if rate limited
      │
      ▼
GramJS client.sendMessage / sendFile / etc.
      │ (MTProto)
      ▼
Telegram servers
```

### 8.1 Peer Resolution

```typescript
// chatId formats supported:
// - numeric: 267619672 (user), -1001234567890 (supergroup)
// - username: "@amazing_nero"
// - OpenClaw target: "telegram-userbot:267619672"

async function resolvePeer(chatId: string | number): Promise<Api.TypeInputPeer> {
  if (typeof chatId === "number") {
    return client.getInputEntity(chatId);
  }
  if (chatId.startsWith("@")) {
    return client.getInputEntity(chatId);
  }
  // Parse OpenClaw target format
  const parsed = parseTelegramTarget(chatId);
  return client.getInputEntity(parsed.peerId);
}
```

---

## 9. Connection Lifecycle

```
Gateway start
      │
      ├─ loadConfig() → telegram-userbot enabled?
      │       NO → skip
      │       YES ↓
      ├─ sessionStore.load() → session string
      │       NULL → log warning "run openclaw channels add"
      │       EXISTS ↓
      ├─ client.connect(session)
      │       AUTH_ERROR → log error, mark disconnected
      │       OK ↓
      ├─ client.getMe() → verify identity
      │       ↓
      ├─ register event handlers (inbound.ts)
      │       ↓
      └─ READY (accepting messages)

Reconnection loop:
      ├─ disconnect detected
      ├─ attempt 1: immediate
      ├─ attempt 2-3: 5s delay
      ├─ attempt 4-6: 30s delay
      ├─ attempt 7+: 2min delay
      └─ after N failures: alert user via other channel
```

---

## 10. Flood Control

```typescript
class FloodController {
  private globalBucket: TokenBucket; // 20 ops/sec
  private chatBuckets: Map<string, TokenBucket>; // 1 msg/sec per chat
  private floodWaitUntil: number = 0; // global pause

  async acquire(chatId: string): Promise<void> {
    // 1. Check global flood_wait
    if (Date.now() < this.floodWaitUntil) {
      await sleep(this.floodWaitUntil - Date.now());
    }
    // 2. Global rate
    await this.globalBucket.acquire();
    // 3. Per-chat rate
    const chatBucket = this.getOrCreateChatBucket(chatId);
    await chatBucket.acquire();
    // 4. Human jitter
    await sleep(randomBetween(50, 200));
  }

  reportFloodWait(seconds: number): void {
    this.floodWaitUntil = Date.now() + seconds * 1000;
    log.warn(`Flood wait: ${seconds}s`);
  }
}
```

---

## 11. Differences from Bot Channel

| Aspect        | telegram (bot)        | telegram-userbot             |
| ------------- | --------------------- | ---------------------------- |
| Protocol      | Bot API (HTTPS)       | MTProto (TCP)                |
| Library       | grammy                | GramJS (telegram)            |
| Inbound       | Webhook / long-poll   | Event handler (push)         |
| Identity      | Bot (@BotFather)      | User account                 |
| Auth          | Bot token             | Phone + code + session       |
| Delete others | Admin only (groups)   | Always (DMs), admin (groups) |
| File upload   | Bot API multipart     | MTProto binary               |
| Rate limits   | Bot API limits        | User limits (higher)         |
| Typing        | sendChatAction        | MTProto SetTyping            |
| History       | Only updates received | Full getHistory              |
| Config key    | channels.telegram     | channels.telegram-userbot    |

---

## 12. Security Considerations

- **Session string** = full account access. Stored with `chmod 600` in credentials dir.
- **API hash** is secret. Stored in config (encrypted at rest) or 1Password.
- **allowFrom** enforced same as bot channel — only listed user IDs can interact.
- **Never log** message content, session strings, or auth codes.
- **Rate limiting** prevents triggering Telegram's anti-spam systems.
- **Separate account** recommended (not personal) to avoid ban risk.
- **No password/2FA storage** — only session string persisted post-auth.

---

## 13. Testing Strategy

| Level       | What                           | How                   |
| ----------- | ------------------------------ | --------------------- |
| Unit        | Peer resolution, normalization | Vitest, no network    |
| Unit        | Flood control logic            | Vitest, fake timers   |
| Unit        | Config schema validation       | Vitest                |
| Unit        | Adapter wiring                 | Vitest, mocked client |
| Integration | Connection lifecycle           | Real account, CI skip |
| Integration | Send/delete/react              | Real account, CI skip |
| E2E         | Inbound → agent → outbound     | Two accounts talking  |

---

## 14. Dependencies

| Package               | Version      | Purpose                 | Size |
| --------------------- | ------------ | ----------------------- | ---- |
| `telegram` (GramJS)   | ^2.26.x      | MTProto client          | ~2MB |
| `big-integer`         | (transitive) | GramJS dependency       | —    |
| No new native modules | —            | Keeps deployment simple | —    |
