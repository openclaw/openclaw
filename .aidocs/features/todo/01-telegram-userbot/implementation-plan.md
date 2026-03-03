# Implementation Plan: Telegram Userbot Channel

**Status:** Draft
**Date:** 2026-03-02
**Spec:** [spec.md](./spec.md)
**Design:** [design.md](./design.md)

---

## Phase 1: Core Infrastructure (~80k tokens)

### TASK-01: GramJS Client Wrapper

**Complexity:** Medium
**Dependencies:** None
**Files:**

- `src/telegram-userbot/client.ts` — GramJS client wrapper
- `src/telegram-userbot/types.ts` — TypeScript interfaces
- `src/telegram-userbot/index.ts` — public exports

**Acceptance:**

- [ ] `UserbotClient` class wrapping TelegramClient
- [ ] `connect(sessionString)` — connect with existing session
- [ ] `connectInteractive(apiId, apiHash, phoneNumber)` — interactive auth (for setup)
- [ ] `disconnect()` — graceful shutdown
- [ ] `getMe()` — return current user info
- [ ] `isConnected()` — connection state
- [ ] Core message operations:
  - [ ] `sendMessage(peer, text, opts)` — send text with reply/formatting/buttons
  - [ ] `sendFile(peer, file, opts)` — send file (forceDocument option)
  - [ ] `editMessage(peer, msgId, text)` — edit own message
  - [ ] `deleteMessages(peer, msgIds, revoke)` — delete messages
  - [ ] `forwardMessages(fromPeer, toPeer, msgIds)` — forward
  - [ ] `reactToMessage(peer, msgId, emoji)` — add reaction
  - [ ] `pinMessage(peer, msgId)` — pin message
  - [ ] `getHistory(peer, limit)` — read chat history
  - [ ] `setTyping(peer)` — send typing indicator
- [ ] Peer resolution: number, username, entity cache
- [ ] Error wrapping: GramJS errors → typed OpenClaw errors
- [ ] Unit tests with mocked GramJS

### TASK-02: Session Store

**Complexity:** Low
**Dependencies:** None
**Files:**

- `src/telegram-userbot/session-store.ts`

**Acceptance:**

- [ ] `load(accountId): string | null` — read from `~/.openclaw/credentials/telegram-userbot-{id}.session`
- [ ] `save(accountId, session)` — write with `chmod 600`
- [ ] `clear(accountId)` — delete session file
- [ ] `exists(accountId)` — check without loading
- [ ] Auto-create credentials directory if missing
- [ ] Unit tests

### TASK-03: Connection Manager

**Complexity:** Medium
**Dependencies:** TASK-01, TASK-02
**Files:**

- `src/telegram-userbot/connection.ts`

**Acceptance:**

- [ ] `start(config)` — load session → connect → register keepalive
- [ ] `stop()` — disconnect, save session
- [ ] `restart()` — stop + start
- [ ] Reconnection strategy:
  - [ ] Immediate retry (1x)
  - [ ] 5s delay (2x)
  - [ ] 30s delay (3x)
  - [ ] 2min delay (infinite)
- [ ] `health(): ConnectionHealth` — connected, latency, uptime, reconnects
- [ ] Event emitter: `connected`, `disconnected`, `reconnecting`, `authError`
- [ ] Handle `AUTH_KEY_UNREGISTERED` → mark disconnected, emit authError
- [ ] Alert after N consecutive failures (configurable)
- [ ] Unit tests with mocked client

### TASK-04: Flood Control

**Complexity:** Medium
**Dependencies:** None
**Files:**

- `src/telegram-userbot/flood-control.ts`

**Acceptance:**

- [ ] Token bucket: configurable global rate (default 20/sec)
- [ ] Per-chat bucket: configurable (default 1/sec)
- [ ] `acquire(chatId): Promise<void>` — wait if rate limited
- [ ] `reportFloodWait(seconds)` — global pause
- [ ] Random jitter: configurable range (default 50-200ms)
- [ ] Metrics: total waits, total flood_waits, average wait time
- [ ] Unit tests with fake timers

---

## Phase 2: Channel Plugin Registration (~70k tokens)

### TASK-05: Config Schema & Registration

**Complexity:** Medium
**Dependencies:** None
**Files:**

- `src/telegram-userbot/config.ts` — Zod schema + type
- `src/channels/registry.ts` — add `"telegram-userbot"` to `CHAT_CHANNEL_ORDER`
- `src/config/config.ts` — extend config types (if needed)

**Acceptance:**

- [ ] Zod schema: apiId, apiHash, allowFrom, rateLimit, reconnect, capabilities
- [ ] `channels.telegram-userbot` config section
- [ ] Channel ID `"telegram-userbot"` registered in `CHAT_CHANNEL_ORDER`
- [ ] Channel meta: label, docs path, blurb, systemImage
- [ ] Backward compatible: missing config = channel disabled
- [ ] Validation: apiId + apiHash required if section present
- [ ] Unit tests for schema validation

### TASK-06: Plugin Entry Point & Adapter Wiring

**Complexity:** High
**Dependencies:** TASK-01, TASK-03, TASK-05
**Files:**

- `src/telegram-userbot/plugin.ts` — ChannelPlugin definition
- `src/telegram-userbot/adapters/setup.ts` — setup adapter
- `src/telegram-userbot/adapters/auth.ts` — auth adapter
- `src/telegram-userbot/adapters/config.ts` — config adapter
- `src/telegram-userbot/adapters/status.ts` — status adapter
- `src/telegram-userbot/adapters/security.ts` — security adapter
- Plugin loader registration

**Acceptance:**

- [ ] `ChannelPlugin` object with all required adapters
- [ ] `registerChannel(plugin)` called on plugin load
- [ ] Setup adapter: interactive auth flow (phone + code + 2FA)
- [ ] Auth adapter: allowFrom enforcement
- [ ] Config adapter: read/write/validate config
- [ ] Status adapter: connection health for `openclaw status`
- [ ] Security adapter: DM/group policies
- [ ] `openclaw channels list` shows telegram-userbot
- [ ] `openclaw channels status` shows connection state
- [ ] Integration test: plugin loads and registers

### TASK-07: Inbound Message Handler

**Complexity:** High
**Dependencies:** TASK-01, TASK-06
**Files:**

- `src/telegram-userbot/inbound.ts` — event handler → OpenClaw inbound
- `src/telegram-userbot/helpers.ts` — message conversion helpers
- `src/telegram-userbot/normalize.ts` — chat ID normalization

**Acceptance:**

- [ ] `NewMessage` event → OpenClaw inbound message
- [ ] `MessageEdited` event → edit notification
- [ ] Message fields mapped:
  - [ ] chatId, messageId, text, senderId, senderName
  - [ ] replyTo (quoted message context)
  - [ ] media: photo, document, voice, video, sticker
  - [ ] forward info
  - [ ] chat type: private, group, supergroup, channel
- [ ] Media download: MTProto → save to media dir → attach path
- [ ] Filter: only process from allowFrom users
- [ ] Ignore own outgoing messages (prevent echo loops)
- [ ] Chat ID normalization: consistent format with bot channel
- [ ] Group context: chat title, member count, admin status
- [ ] Unit tests for message conversion
- [ ] Integration test: receive real message

### TASK-08: Outbound Adapter

**Complexity:** High
**Dependencies:** TASK-01, TASK-04, TASK-06
**Files:**

- `src/telegram-userbot/outbound.ts` — OpenClaw outbound → GramJS
- `src/telegram-userbot/adapters/outbound.ts` — ChannelOutboundAdapter impl

**Acceptance:**

- [ ] Send text message (with markdown/HTML formatting)
- [ ] Send media: photo, document, voice, video
- [ ] Force document mode: images sent as files (not compressed)
- [ ] Reply to message (replyTo param)
- [ ] Inline buttons (reply markup)
- [ ] Message chunking: split long messages (4096 char limit)
- [ ] Return sent messageId for tracking
- [ ] Flood control integration: `acquire()` before every send
- [ ] Error handling: catch GramJS errors, return typed errors
- [ ] Fallback: if send fails, log and report (no silent swallow)
- [ ] Unit tests with mocked client
- [ ] Integration test: send real message

---

## Phase 3: Message Actions & Tools (~50k tokens)

### TASK-09: Message Actions Adapter

**Complexity:** Medium
**Dependencies:** TASK-08
**Files:**

- `src/telegram-userbot/adapters/message-actions.ts`

**Acceptance:**

- [ ] `delete`: delete messages (own + other's in DM, admin in groups)
- [ ] `edit`: edit own sent messages
- [ ] `react`: add emoji reaction to any message
- [ ] `forward`: forward messages between chats
- [ ] `pin`: pin/unpin messages
- [ ] `topic-create`: create forum topics (if admin)
- [ ] Each action checks capabilities before executing
- [ ] Error messages for unsupported actions
- [ ] Unit tests per action

### TASK-10: Extended Tool Capabilities

**Complexity:** Medium
**Dependencies:** TASK-09
**Files:**

- `src/telegram-userbot/adapters/agent-prompt.ts` — agent context
- Update tool schemas if needed for new actions

**Acceptance:**

- [ ] Agent prompt includes userbot capabilities
- [ ] `message` tool works with `channel: "telegram-userbot"`
- [ ] All standard actions: send, delete, edit, react
- [ ] New capabilities exposed:
  - [ ] Delete other's messages (DM)
  - [ ] Read chat history
  - [ ] Forward messages
  - [ ] Pin messages
- [ ] Capabilities reported dynamically based on connection state

### TASK-11: Streaming & Typing Adapter

**Complexity:** Low
**Dependencies:** TASK-01, TASK-06
**Files:**

- `src/telegram-userbot/adapters/streaming.ts`

**Acceptance:**

- [ ] Send typing indicator via MTProto `SetTyping`
- [ ] Cancel typing on message send
- [ ] Typing action types: typing, uploadPhoto, uploadDocument, recordVoice
- [ ] Unit tests

### TASK-12: Directory & Threading Adapters

**Complexity:** Medium
**Dependencies:** TASK-01, TASK-06
**Files:**

- `src/telegram-userbot/adapters/directory.ts`
- `src/telegram-userbot/adapters/threading.ts`

**Acceptance:**

- [ ] Directory: list recent dialogs, resolve username → peer
- [ ] Directory: search contacts by name
- [ ] Threading: support forum topics (supergroups with topics)
- [ ] Threading: reply in topic threads
- [ ] Unit tests

---

## Phase 4: Setup UX & Observability (~30k tokens)

### TASK-13: CLI Setup Wizard

**Complexity:** Medium
**Dependencies:** TASK-02, TASK-05, TASK-06
**Files:**

- Setup adapter already in TASK-06
- `src/wizard/telegram-userbot.ts` (if separate wizard needed)

**Acceptance:**

- [ ] `openclaw channels add --channel telegram-userbot`
- [ ] Interactive prompts: apiId, apiHash, phone, code, 2FA
- [ ] Non-interactive: `--api-id X --api-hash Y` (session must exist)
- [ ] Verify connection before saving config
- [ ] Handle session already exists (re-auth option)
- [ ] Handle auth failure (wrong code, expired code)
- [ ] Display success: "Connected as @username (ID: 123)"

### TASK-14: Status & Monitoring

**Complexity:** Low
**Dependencies:** TASK-03, TASK-06
**Files:**

- `src/telegram-userbot/adapters/status.ts` (already in TASK-06)
- `src/telegram-userbot/monitor.ts` — health metrics

**Acceptance:**

- [ ] `openclaw status` shows:
  ```
  telegram-userbot: ✓ connected (@amazing_nero, uptime 2h, DC5)
  ```
- [ ] `openclaw channels status --probe` tests connection health
- [ ] Log flood_wait events with duration
- [ ] Log reconnection events with attempt count
- [ ] Metric counters: messages_sent, messages_received, errors, flood_waits
- [ ] Alert via other channel if disconnected for >5 min

---

## Phase 5: Hardening & Docs (~30k tokens)

### TASK-15: Integration Tests

**Complexity:** Medium
**Dependencies:** All above
**Files:**

- `src/telegram-userbot/**/*.test.ts`

**Acceptance:**

- [ ] Connection lifecycle: connect → disconnect → reconnect
- [ ] Inbound: receive message → agent processes
- [ ] Outbound: agent reply → message delivered
- [ ] Actions: delete, react, forward, pin
- [ ] Flood control: concurrent sends respect limits
- [ ] Config: enable/disable, validation errors
- [ ] Fallback: graceful handling when disconnected
- [ ] Allow list: blocked user's messages ignored

### TASK-16: Documentation

**Complexity:** Low
**Dependencies:** All above
**Files:**

- `docs/channels/telegram-userbot.md`
- Update `docs/channels/index.md` to list new channel

**Acceptance:**

- [ ] Prerequisites: get API ID/Hash from my.telegram.org
- [ ] Setup guide: step-by-step with screenshots
- [ ] Config reference: all options documented
- [ ] Architecture: how it differs from bot channel
- [ ] Running both channels: coexistence guide
- [ ] Troubleshooting: session invalid, flood wait, banned, etc.
- [ ] Security: best practices, separate account recommendation
- [ ] FAQ

---

## Execution Order & Dependencies

```
TASK-01 (Client) ──────────┐
TASK-02 (Session) ─────────┤
TASK-04 (Flood) ───────────┤
TASK-05 (Config) ──────────┤
                           │
                           ▼
              TASK-03 (Connection) ──┐
              TASK-06 (Plugin) ──────┤
                                     │
                    ┌────────────────┤
                    ▼                ▼
           TASK-07 (Inbound)   TASK-08 (Outbound)
                    │                │
                    └───────┬────────┘
                            ▼
                   TASK-09 (Actions)
                   TASK-10 (Tools)
                   TASK-11 (Streaming)
                   TASK-12 (Directory)
                            │
                            ▼
                   TASK-13 (CLI Setup)
                   TASK-14 (Monitoring)
                            │
                            ▼
                   TASK-15 (Tests)
                   TASK-16 (Docs)
```

**Parallelizable groups:**

- Group A: TASK-01 + TASK-02 + TASK-04 + TASK-05 (all independent)
- Group B: TASK-07 + TASK-08 (after Group A + TASK-03 + TASK-06)
- Group C: TASK-09 + TASK-10 + TASK-11 + TASK-12 (after Group B)
- Group D: TASK-13 + TASK-14 (after TASK-06)
- Group E: TASK-15 + TASK-16 (after all)

---

## Estimates

| Phase                    | Tasks  | Complexity  | Tokens    |
| ------------------------ | ------ | ----------- | --------- |
| 1: Core Infrastructure   | 4      | Medium-High | ~80k      |
| 2: Plugin Registration   | 4      | High        | ~70k      |
| 3: Actions & Tools       | 4      | Medium      | ~50k      |
| 4: Setup & Observability | 2      | Medium-Low  | ~30k      |
| 5: Hardening & Docs      | 2      | Medium-Low  | ~30k      |
| **Total**                | **16** | —           | **~260k** |

---

## 100k Rule Compliance

- No single task exceeds 50k tokens
- Each task produces testable, deployable output
- Phase 1+2 deliver a working channel (inbound + outbound)
- Phase 3 adds full capabilities
- Phase 4+5 polish and harden
- Each phase is independently deployable
