# TASK_08: Outbound Adapter

<!-- SUMMARY: Sends agent responses through the user's Telegram account via MTProto, supporting text, media, replies, and formatting -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | complex             |
| **Est. Tokens** | ~30k                |
| **Priority**    | P0                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 2                   |
| **Wave**        | 3                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                              |
| --------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 SC-1 (Send as user), SC-2 (Files as documents)                     |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.2 Outbound Adapter, §8 Outbound Message Flow, §8.1 Peer Resolution |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-08                                                               |

## Task Dependency Tree

```
TASK-01 (Client) ────┐
TASK-04 (Flood) ─────┤
TASK-06 (Plugin) ────┤
                     ▼
           TASK-08 (Outbound) ←── you are here
                     │
                     ├──► TASK-09 (Actions) — extends outbound with delete/react/etc.
                     └──► TASK-15 (Integration Tests) — end-to-end outbound flow
```

## Description

Implement the `ChannelOutboundAdapter` that translates OpenClaw outbound actions to GramJS API calls:

1. Send text with Markdown/HTML formatting
2. Send media (photo, document, voice, video) with forceDocument option
3. Reply to messages (replyTo parameter)
4. Inline buttons (reply markup)
5. Message chunking for messages exceeding Telegram's 4096 char limit
6. Flood control integration — `acquire()` before every send
7. Error handling — catch GramJS errors, return typed results

**Business value:** Enables the agent to send messages and files from the user's account (SC-1, SC-2 from spec), with messages appearing as from the user, not a bot.

---

## Context

### Related Files (from codebase research)

| File                                                   | Purpose                            | Patterns to Follow                                                  |
| ------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------- |
| `extensions/discord/src/channel.ts` (lines 299-341)    | Discord outbound adapter           | `sendText`, `sendMedia` implementation pattern                      |
| `extensions/irc/src/channel.ts` (lines 294-314)        | IRC outbound adapter               | Simple sendText pattern                                             |
| `extensions/googlechat/src/channel.ts` (lines 381-472) | Google Chat outbound               | Complex sendText/sendMedia with formatting                          |
| `src/channels/plugins/types.adapters.ts` (line 106)    | `ChannelOutboundAdapter` interface | deliveryMode, chunker, sendText, sendMedia, sendPoll, resolveTarget |

### Code Dependencies

- `UserbotClient` from TASK-01 — sendMessage, sendFile methods
- `FloodController` from TASK-04 — acquire() for rate limiting
- `telegram/tl/api` — `Api.Message`, formatting types

---

## Goals

1. Full `ChannelOutboundAdapter` implementation (sendText, sendMedia, resolveTarget, chunker)
2. Flood control integration (acquire before every send)
3. Message chunking for >4096 char messages
4. forceDocument mode for file uploads
5. Error handling with typed results

---

## Acceptance Criteria

**AC-1: Send text message**

- Given: Agent produces text reply for a chat
- When: `sendText({ target, text, ... })` is called
- Then: Message is sent via GramJS `client.sendMessage()` and message ID is returned

**AC-2: Send media — document mode**

- Given: Agent sends a file with forceDocument enabled
- When: `sendMedia({ target, media, ... })` is called
- Then: File is sent via `client.sendFile({ forceDocument: true })` as a document

**AC-3: Send media — photo mode**

- Given: Agent sends a photo
- When: `sendMedia({ target, media: { type: "photo" }, ... })` is called
- Then: Photo is sent via `client.sendFile({ forceDocument: false })`

**AC-4: Reply to message**

- Given: Agent reply targets a specific message
- When: `sendText({ target, text, replyTo: messageId })` is called
- Then: GramJS sends with replyTo parameter

**AC-5: Message chunking**

- Given: Agent produces a 6000-character message
- When: `sendText()` is called
- Then: Message is split into chunks ≤4096 chars at paragraph/sentence boundaries

**AC-6: Flood control integration**

- Given: FloodController has active rate limits
- When: Multiple sends are queued
- Then: Each send calls `floodController.acquire(chatId)` before executing

**AC-7: Error handling**

- Given: GramJS throws an error during send
- When: Error is caught
- Then: Returns typed error result (not thrown), error is logged

**AC-8: Target resolution**

- Given: Target in OpenClaw format "telegram-userbot:267619672"
- When: `resolveTarget(target)` is called
- Then: Returns validated target with resolved peer

---

## Dependencies

**Depends on:**

- TASK-01 (Client) — sendMessage, sendFile, peer resolution
- TASK-04 (Flood Control) — acquire() rate limiting
- TASK-06 (Plugin Entry) — wired as outbound adapter

**Blocks:**

- TASK-09 (Message Actions) — builds on outbound for delete/react/forward/pin
- TASK-15 (Integration Tests) — end-to-end outbound flow

---

## Files to Change

| Action | File                                                   | Scope                                           |
| ------ | ------------------------------------------------------ | ----------------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/outbound.ts`          | Core outbound logic (send, chunk, resolve)      |
| CREATE | `extensions/telegram-userbot/src/adapters/outbound.ts` | ChannelOutboundAdapter implementation           |
| CREATE | `extensions/telegram-userbot/src/outbound.test.ts`     | Unit tests with mocked client and flood control |

---

## Risks & Mitigations

| Risk                                | Likelihood | Impact | Mitigation                                                      |
| ----------------------------------- | ---------- | ------ | --------------------------------------------------------------- |
| Message formatting incompatibility  | Medium     | Low    | Test all formatting options, fallback to plain text             |
| File upload timeout for large files | Low        | Medium | Set timeout, report progress, max file size check               |
| Chunking breaks markdown formatting | Medium     | Low    | Smart chunking at paragraph boundaries, re-open markdown blocks |

---

## Out of Scope

- Message deletion, editing, reactions, forwarding, pinning (TASK-09)
- Typing indicators (TASK-11)
- Poll sending (not supported in v1)

---

## Testing

| Type | Description                                                  | File                                               |
| ---- | ------------------------------------------------------------ | -------------------------------------------------- |
| Unit | sendText delegates to client.sendMessage with correct params | `extensions/telegram-userbot/src/outbound.test.ts` |
| Unit | sendMedia with forceDocument                                 | `extensions/telegram-userbot/src/outbound.test.ts` |
| Unit | Reply-to parameter passed correctly                          | `extensions/telegram-userbot/src/outbound.test.ts` |
| Unit | Message chunking at 4096 chars                               | `extensions/telegram-userbot/src/outbound.test.ts` |
| Unit | Flood control acquire called before send                     | `extensions/telegram-userbot/src/outbound.test.ts` |
| Unit | Error handling wraps GramJS errors                           | `extensions/telegram-userbot/src/outbound.test.ts` |
| Unit | Target resolution for various formats                        | `extensions/telegram-userbot/src/outbound.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                         |
| -------------- | ------ | --------------------------------------------- |
| Research       | ~6k    | Study existing outbound adapters in detail    |
| Implementation | ~18k   | Outbound adapter, chunking, flood integration |
| Testing        | ~6k    | Unit tests with mocked dependencies           |
| **Total**      | ~30k   | Core sending infrastructure                   |

---

## Subtasks

- [ ] 1.  Create `outbound.ts` with core send logic (text, media)
- [ ] 2.  Implement message chunking for >4096 char messages
- [ ] 3.  Implement forceDocument mode for file uploads
- [ ] 4.  Implement reply-to and inline buttons support
- [ ] 5.  Integrate FloodController.acquire() before every send
- [ ] 6.  Implement error handling (catch GramJS errors → typed results)
- [ ] 7.  Create `adapters/outbound.ts` wrapping as ChannelOutboundAdapter
- [ ] 8.  Implement resolveTarget for OpenClaw target format
- [ ] 9.  Write unit tests with mocked client and flood controller
