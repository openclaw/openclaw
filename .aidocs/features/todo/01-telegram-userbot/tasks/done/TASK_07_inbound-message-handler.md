# TASK_07: Inbound Message Handler

<!-- SUMMARY: Converts incoming MTProto events into OpenClaw inbound messages enabling the agent to receive and process user messages -->

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

| Document  | Path                                                               | Sections                                                                               |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 SC-5 (Read chat history), §6 US-3 (Hybrid operation)                                |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.3 Messaging Adapter, §7 Inbound Message Flow, §7.1 Event Types, §7.2 Media Handling |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-07                                                                                |

## Task Dependency Tree

```
TASK-01 (Client) ────┐
TASK-06 (Plugin) ────┤
                     ▼
           TASK-07 (Inbound) ←── you are here
                     │
                     └──► TASK-15 (Integration Tests) — end-to-end inbound flow
```

## Description

Implement the inbound message handler that:

1. Registers GramJS event handlers (`NewMessage`, `MessageEdited`, `CallbackQuery`, `MessageDeleted`)
2. Converts MTProto events to OpenClaw `InboundMessage` format
3. Downloads media (photos, documents, voice, video) and saves to media directory
4. Normalizes chat IDs for consistency with the bot channel
5. Resolves sender names and chat context (title, type, member count)
6. Filters messages via allowFrom list
7. Ignores own outgoing messages (prevents echo loops)
8. Routes converted messages to the OpenClaw gateway for agent processing

**Business value:** Enables the agent to receive and process messages from Telegram via the user account, supporting all inbound use cases (US-1 through US-4).

---

## Context

### Related Files (from codebase research)

| File                                     | Purpose                     | Patterns to Follow                                   |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------- |
| `extensions/discord/src/channel.ts`      | Discord inbound via gateway | How inbound messages are routed to gateway           |
| `extensions/irc/src/channel.ts`          | IRC inbound                 | Monitor pattern for persistent connections           |
| `extensions/googlechat/src/channel.ts`   | Google Chat inbound         | Webhook-based inbound for comparison                 |
| `src/channels/plugins/types.core.ts`     | ChannelMessagingAdapter     | `normalizeTarget`, `formatDisplayTarget`             |
| `src/channels/plugins/types.adapters.ts` | Adapter types               | Gateway adapter, how startAccount registers monitors |

### Code Dependencies

- `UserbotClient` from TASK-01 — event handler registration, media download
- `telegram/events` — `NewMessage`, `EditedMessage` event classes
- `telegram/tl/api` — `Api.Message`, `Api.MessageMedia*` types

---

## Goals

1. Register event handlers for NewMessage, MessageEdited, CallbackQuery, MessageDeleted
2. Convert MTProto message events to OpenClaw InboundMessage format
3. Download and save media attachments
4. Normalize chat IDs consistently
5. Filter by allowFrom, ignore own messages

---

## Acceptance Criteria

**AC-1: Text message inbound**

- Given: A user sends a text message in a chat where the userbot is present
- When: GramJS fires NewMessage event
- Then: OpenClaw receives InboundMessage with channel="telegram-userbot", correct chatId, messageId, text, senderId, senderName

**AC-2: Media message inbound**

- Given: A user sends a photo/document/voice in a chat
- When: GramJS fires NewMessage with media
- Then: Media is downloaded, saved to media dir, and InboundMessage includes mediaPath and mimeType

**AC-3: Message edit notification**

- Given: A user edits a previously sent message
- When: GramJS fires MessageEdited event
- Then: Edit event is routed to gateway with original messageId and new text

**AC-4: Reply context**

- Given: A user replies to an existing message
- When: GramJS fires NewMessage with replyTo
- Then: InboundMessage includes replyToMessageId and quoted text

**AC-5: Chat type resolution**

- Given: Messages from private DM, group, supergroup, or channel
- When: Events are processed
- Then: Chat type is correctly identified (private/group/supergroup/channel)

**AC-6: AllowFrom filtering**

- Given: allowFrom is [267619672]
- When: Message from user 999999 arrives
- Then: Message is silently ignored (not routed to gateway)

**AC-7: Own message echo prevention**

- Given: Userbot sends a message (outbound)
- When: GramJS fires NewMessage for the sent message
- Then: The message is ignored (no echo loop)

**AC-8: Chat ID normalization**

- Given: Supergroup with ID -1001234567890
- When: Chat ID is normalized
- Then: Produces consistent format usable by both inbound and outbound

---

## Dependencies

**Depends on:**

- TASK-01 (Client) — event handler registration, media download
- TASK-06 (Plugin Entry) — gateway adapter starts the monitor

**Blocks:**

- TASK-15 (Integration Tests) — tests full inbound flow

---

## Files to Change

| Action | File                                                | Scope                                                 |
| ------ | --------------------------------------------------- | ----------------------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/inbound.ts`        | Event handlers → InboundMessage conversion            |
| CREATE | `extensions/telegram-userbot/src/helpers.ts`        | Message conversion, sender resolution, media handling |
| CREATE | `extensions/telegram-userbot/src/normalize.ts`      | Chat ID normalization utilities                       |
| CREATE | `extensions/telegram-userbot/src/inbound.test.ts`   | Unit tests for message conversion                     |
| CREATE | `extensions/telegram-userbot/src/normalize.test.ts` | Unit tests for normalization                          |

---

## Risks & Mitigations

| Risk                                     | Likelihood | Impact | Mitigation                                              |
| ---------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| Media download fails / times out         | Medium     | Low    | Catch error, deliver message without media, log warning |
| Large media files consume disk           | Low        | Medium | Set max download size, skip oversized media             |
| Chat ID format differs from bot channel  | Medium     | Medium | Test normalization against known IDs from both channels |
| Echo loop if own-message detection fails | Medium     | High   | Check message senderId against getMe() result           |

---

## Out of Scope

- Outbound message sending (TASK-08)
- Message actions (delete, edit, react) — TASK-09
- History reading (getHistory) — part of TASK-10 capabilities
- Inline bot callbacks from this channel

---

## Testing

| Type | Description                                    | File                                                |
| ---- | ---------------------------------------------- | --------------------------------------------------- |
| Unit | NewMessage → InboundMessage conversion         | `extensions/telegram-userbot/src/inbound.test.ts`   |
| Unit | Media attachment handling                      | `extensions/telegram-userbot/src/inbound.test.ts`   |
| Unit | Reply context extraction                       | `extensions/telegram-userbot/src/inbound.test.ts`   |
| Unit | Chat type detection (private/group/supergroup) | `extensions/telegram-userbot/src/inbound.test.ts`   |
| Unit | AllowFrom filtering                            | `extensions/telegram-userbot/src/inbound.test.ts`   |
| Unit | Own message echo prevention                    | `extensions/telegram-userbot/src/inbound.test.ts`   |
| Unit | Chat ID normalization                          | `extensions/telegram-userbot/src/normalize.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                         |
| -------------- | ------ | --------------------------------------------- |
| Research       | ~6k    | GramJS event types, existing inbound patterns |
| Implementation | ~18k   | Inbound handler, helpers, normalization       |
| Testing        | ~6k    | Unit tests for conversion + normalization     |
| **Total**      | ~30k   | Complex message mapping                       |

---

## Subtasks

- [ ] 1.  Create `normalize.ts` with chat ID normalization (numeric, supergroup prefix handling)
- [ ] 2.  Create `helpers.ts` with message conversion functions (MTProto → OpenClaw format)
- [ ] 3.  Implement sender name resolution (from entity or fallback)
- [ ] 4.  Implement media download and save to media directory
- [ ] 5.  Create `inbound.ts` with NewMessage event handler
- [ ] 6.  Add MessageEdited event handler
- [ ] 7.  Add CallbackQuery and MessageDeleted handlers
- [ ] 8.  Implement allowFrom filtering
- [ ] 9.  Implement own-message echo prevention
- [ ] 10. Write unit tests for message conversion, normalization, and filtering
