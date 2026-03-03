# Specification: Telegram Userbot Channel

**Status:** Draft
**Author:** NERO
**Date:** 2026-03-02
**Complexity:** High (~250k tokens)

---

## 1. Problem Statement

OpenClaw's Telegram integration uses the **Bot API** exclusively. Bots have hard limitations:

- Cannot delete other users' messages
- Cannot send files as documents reliably (images auto-compressed)
- Cannot read full chat history
- Cannot initiate conversations (user must /start first)
- Cannot use custom reactions on all message types
- Limited formatting compared to user messages
- Rate limits stricter than user accounts
- No access to user-only features (drafts, scheduled messages, etc.)

## 2. Proposed Solution

Register a **new channel `telegram-userbot`** in OpenClaw's plugin system, powered by **GramJS** (MTProto protocol). This is a **separate, independent channel** — like how `whatsapp`, `discord`, `signal` are separate channels. It follows the same `ChannelPlugin` interface and registers via `registerChannel()`.

### 2.1 Key Architectural Decision

This is NOT an extension of the existing `telegram` (Bot API) channel. It is a **separate channel plugin** with its own:

- Channel ID: `telegram-userbot`
- Config section: `channels.telegram-userbot`
- Inbound listener (MTProto event handler)
- Outbound adapter (GramJS sends)
- Session management
- Setup/auth flow
- Status reporting

### 2.2 Why Separate Channel (not hybrid)

| Concern         | Separate Channel                     | Hybrid Extension         |
| --------------- | ------------------------------------ | ------------------------ |
| Complexity      | Clean, follows existing patterns     | Entangled with bot code  |
| Maintainability | Independent lifecycle                | Coupled to bot changes   |
| Config          | Own section, clear                   | Mixed in telegram config |
| Upstream merges | No conflicts with bot code           | Constant merge conflicts |
| Multi-account   | Natural (separate accounts)          | Awkward                  |
| Fallback        | Can run both channels simultaneously | Complex routing          |
| Testing         | Isolated                             | Interleaved              |

### 2.3 Coexistence with Bot Channel

Both channels can run simultaneously. OpenClaw already supports multiple channels.
The agent chooses which channel to use for outbound via the `message` tool `channel` param.

```
channels:
  telegram:          # Existing Bot API — unchanged
    botToken: "..."
  telegram-userbot:  # NEW — independent channel
    apiId: 14858133
    apiHash: "..."
```

## 3. Success Criteria

| #     | Criterion                               | Metric                                    |
| ----- | --------------------------------------- | ----------------------------------------- |
| SC-1  | Send messages as user account           | Messages appear from user, not bot        |
| SC-2  | Send files as documents                 | Files arrive as documents, not photos     |
| SC-3  | Delete any message in DM                | Own + other party's messages deletable    |
| SC-4  | Delete messages in groups (where admin) | Admin-level message deletion              |
| SC-5  | Read chat history                       | Full history access, not just bot-visible |
| SC-6  | React to messages                       | Full emoji reaction support               |
| SC-7  | Forward messages                        | Forward between chats                     |
| SC-8  | Edit own messages                       | Edit sent messages                        |
| SC-9  | Graceful fallback                       | If userbot down, bot API takes over       |
| SC-10 | Session persistence                     | Survives restarts without re-auth         |
| SC-11 | Multi-account support                   | Multiple userbot accounts possible        |
| SC-12 | No disruption to existing bot flow      | Bot API continues working as-is           |

## 4. Non-Goals (v1)

- Voice/video calls
- Telegram Premium features (custom emoji packs, etc.)
- Inline bot mode via userbot
- Channel management (post as channel)
- Userbot as sole inbound listener (webhook is faster/simpler)

## 5. Risks

| Risk                        | Impact | Mitigation                                                    |
| --------------------------- | ------ | ------------------------------------------------------------- |
| Account ban (ToS violation) | High   | Conservative rate limits, human-like delays, no spam behavior |
| Session invalidation        | Medium | Auto-reconnect, alert user, re-auth flow                      |
| GramJS breaking changes     | Low    | Pin version, integration tests                                |
| MTProto connection issues   | Medium | Retry logic, fallback to Bot API                              |
| Flood wait from Telegram    | Medium | Respect flood_wait, exponential backoff                       |

## 6. User Stories

### US-1: Delete sensitive message

> As Ruslan, I want NERO to delete a message containing a token I accidentally sent, so it's not visible in chat history.

### US-2: Send file as document

> As Ruslan, I want NERO to send a PNG file as a document (not compressed photo), so I can download the original quality.

### US-3: Hybrid operation

> As a user, I want the bot to receive my messages instantly (webhook) but reply as my userbot account, so responses look natural.

### US-4: Message management

> As Ruslan, I want NERO to forward, edit, or pin messages on my behalf.

---

## 7. Constraints

- **Auth:** Requires phone number + code (one-time), then session string persists
- **Storage:** Session string stored in 1Password or encrypted local file
- **Concurrency:** Single GramJS client per account (MTProto limitation)
- **Telegram limits:** ~30 messages/sec for users, flood_wait must be respected
- **Dependencies:** GramJS (`telegram` npm package), no native modules
