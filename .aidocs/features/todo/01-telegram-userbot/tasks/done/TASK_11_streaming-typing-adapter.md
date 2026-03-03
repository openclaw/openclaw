# TASK_11: Streaming & Typing Adapter

<!-- SUMMARY: Shows typing indicators to Telegram users while the agent is processing, creating a natural conversation feel -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | simple              |
| **Est. Tokens** | ~10k                |
| **Priority**    | P2                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 3                   |
| **Wave**        | 3                   |

---

## SDD References

| Document  | Path                                                               | Sections                                         |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §2 Proposed Solution (user account capabilities) |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.7 Streaming Adapter                           |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-11                                          |

## Task Dependency Tree

```
TASK-01 (Client) ────┐
TASK-06 (Plugin) ────┤
                     ▼
        TASK-11 (Streaming/Typing) ←── you are here
```

## Description

Implement the `ChannelStreamingAdapter` that sends typing indicators via MTProto while the agent is processing a response. Unlike the Bot API's `sendChatAction`, MTProto's `SetTyping` supports richer action types:

- `SendMessageTypingAction` — generic typing
- `SendMessageUploadPhotoAction` — uploading photo
- `SendMessageUploadDocumentAction` — uploading document
- `SendMessageRecordAudioAction` — recording voice

Typing should auto-cancel when a message is sent.

**Business value:** Makes the user experience feel natural — the other party sees "typing..." while the agent works, just like a real human.

---

## Context

### Related Files (from codebase research)

| File                                            | Purpose                             | Patterns to Follow             |
| ----------------------------------------------- | ----------------------------------- | ------------------------------ |
| `src/channels/plugins/types.core.ts` (line 215) | `ChannelStreamingAdapter` interface | coalesceDefaults               |
| `src/channels/plugins/types.plugin.ts`          | Plugin `streaming` slot             | How streaming adapter is wired |

### Code Dependencies

- `UserbotClient` from TASK-01 — setTyping method
- `telegram/tl/api` — `Api.messages.SetTyping`, typing action types

---

## Goals

1. Send typing indicators via MTProto SetTyping
2. Support multiple typing action types (typing, photo, document, voice)
3. Auto-cancel typing when message is sent
4. Configurable coalesce defaults for block streaming

---

## Acceptance Criteria

**AC-1: Typing indicator on processing**

- Given: Agent is processing a response
- When: Streaming adapter signals typing start
- Then: MTProto `SetTyping` with `SendMessageTypingAction` is sent

**AC-2: Upload-specific typing**

- Given: Agent is preparing to send a photo
- When: Streaming adapter signals upload
- Then: `SendMessageUploadPhotoAction` is sent

**AC-3: Typing cancellation**

- Given: Agent has finished processing and sends a message
- When: Message is sent via outbound adapter
- Then: Typing indicator is cancelled

**AC-4: Typing auto-expire**

- Given: Typing indicator is active
- When: 6 seconds pass without re-send (Telegram's auto-expire)
- Then: Typing is automatically re-sent if processing is still ongoing

---

## Dependencies

**Depends on:**

- TASK-01 (Client) — setTyping method
- TASK-06 (Plugin Entry) — adapter wiring

**Blocks:**

- None (optional enhancement)

---

## Files to Change

| Action | File                                                         | Scope                                  |
| ------ | ------------------------------------------------------------ | -------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/adapters/streaming.ts`      | ChannelStreamingAdapter implementation |
| CREATE | `extensions/telegram-userbot/src/adapters/streaming.test.ts` | Unit tests                             |

---

## Risks & Mitigations

| Risk                            | Likelihood | Impact | Mitigation                                                 |
| ------------------------------- | ---------- | ------ | ---------------------------------------------------------- |
| Typing spam triggers rate limit | Low        | Low    | Only send typing every 5s (before Telegram's 6s expire)    |
| Typing not visible in groups    | Low        | Low    | This is expected Telegram behavior for non-admin sometimes |

---

## Out of Scope

- Read receipts (not available via MTProto for user accounts)
- Online/offline status management
- "Choosing sticker" typing action

---

## Testing

| Type | Description                               | File                                                         |
| ---- | ----------------------------------------- | ------------------------------------------------------------ |
| Unit | SetTyping called with correct action type | `extensions/telegram-userbot/src/adapters/streaming.test.ts` |
| Unit | Auto-cancellation on message send         | `extensions/telegram-userbot/src/adapters/streaming.test.ts` |
| Unit | Re-send typing before 6s expiry           | `extensions/telegram-userbot/src/adapters/streaming.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                       |
| -------------- | ------ | --------------------------- |
| Research       | ~2k    | MTProto typing API          |
| Implementation | ~5k    | Streaming adapter           |
| Testing        | ~3k    | Unit tests with fake timers |
| **Total**      | ~10k   | Simple adapter              |

---

## Subtasks

- [ ] 1.  Create `streaming.ts` with ChannelStreamingAdapter
- [ ] 2.  Implement typing indicator via SetTyping
- [ ] 3.  Add typing action type selection (typing, uploadPhoto, uploadDocument, recordAudio)
- [ ] 4.  Implement auto-resend before 6s expiry
- [ ] 5.  Implement cancellation mechanism
- [ ] 6.  Write unit tests with mocked client and fake timers
