# TASK_09: Message Actions Adapter

<!-- SUMMARY: Enables the agent to delete, edit, react, forward, and pin messages via the user account -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~20k                |
| **Priority**    | P1                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 3                   |
| **Wave**        | 3                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                                                   |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 SC-3 (Delete in DM), SC-4 (Delete in groups), SC-6 (React), SC-7 (Forward), SC-8 (Edit) |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.4 Message Actions Adapter                                                               |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-09                                                                                    |

## Task Dependency Tree

```
TASK-08 (Outbound) ───┐
                      ▼
         TASK-09 (Message Actions) ←── you are here
                      │
                      └──► TASK-10 (Extended Tools) — exposes actions to agent
```

## Description

Implement the `ChannelMessageActionAdapter` exposing advanced message operations:

- **delete**: Delete own + other's messages in DMs, admin-level in groups
- **edit**: Edit own sent messages
- **react**: Add emoji reactions to any message
- **forward**: Forward messages between chats
- **pin**: Pin/unpin messages
- **topic-create**: Create forum topics (if admin in supergroup with topics)

Each action checks the channel's `capabilities` config before executing and returns a clear error if the action is not supported or not permitted.

**Business value:** Core differentiator from Bot API — enables message deletion (SC-3, SC-4), reactions (SC-6), forwarding (SC-7), and editing (SC-8).

---

## Context

### Related Files (from codebase research)

| File                                            | Purpose                                 | Patterns to Follow                            |
| ----------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `src/channels/plugins/types.core.ts` (line 334) | `ChannelMessageActionAdapter` interface | Action types, supportedActions, executeAction |
| `src/channels/plugins/types.plugin.ts`          | ChannelPlugin `actions` slot            | How actions adapter is wired                  |
| `extensions/discord/src/channel.ts`             | Discord actions (if any)                | How Discord handles message actions           |
| `src/channels/plugins/plugins-channel.test.ts`  | Channel plugin tests                    | Test patterns for actions                     |

### Code Dependencies

- `UserbotClient` from TASK-01 — deleteMessages, editMessage, reactToMessage, forwardMessages, pinMessage
- `FloodController` from TASK-04 — rate limit actions too

---

## Goals

1. Implement all 6 message actions: delete, edit, react, forward, pin, topic-create
2. Check capabilities config before executing each action
3. Return typed results (success/failure with reason)
4. Integrate flood control for rate-limited actions

---

## Acceptance Criteria

**AC-1: Delete messages in DM**

- Given: Chat is a DM and deleteOtherMessages capability is enabled
- When: `delete` action is called with message IDs
- Then: Messages are deleted with `revoke: true` (deleted for both parties)

**AC-2: Delete messages in group (admin)**

- Given: Chat is a group and userbot is admin
- When: `delete` action is called
- Then: Messages are deleted

**AC-3: Edit own message**

- Given: Message was sent by the userbot
- When: `edit` action is called with new text
- Then: Message is edited via GramJS

**AC-4: React to message**

- Given: Any message in a chat
- When: `react` action is called with emoji
- Then: Reaction is added via `SendReaction` API call

**AC-5: Forward messages**

- Given: Source and destination chats
- When: `forward` action is called with message IDs
- Then: Messages are forwarded via `client.forwardMessages()`

**AC-6: Pin message**

- Given: Message in a chat
- When: `pin` action is called
- Then: Message is pinned via `client.pinMessage()`

**AC-7: Capability check**

- Given: `capabilities.deleteOtherMessages` is false
- When: `delete` action targets another user's message in DM
- Then: Returns error "Capability disabled: deleteOtherMessages"

**AC-8: Unsupported action error**

- Given: Unknown action type
- When: executeAction is called
- Then: Returns error with supported actions list

---

## Dependencies

**Depends on:**

- TASK-08 (Outbound) — shares outbound infrastructure

**Blocks:**

- TASK-10 (Extended Tools) — agent uses actions via tool

---

## Files to Change

| Action | File                                                               | Scope                                      |
| ------ | ------------------------------------------------------------------ | ------------------------------------------ |
| CREATE | `extensions/telegram-userbot/src/adapters/message-actions.ts`      | ChannelMessageActionAdapter implementation |
| CREATE | `extensions/telegram-userbot/src/adapters/message-actions.test.ts` | Unit tests per action                      |

---

## Risks & Mitigations

| Risk                                    | Likelihood | Impact | Mitigation                                           |
| --------------------------------------- | ---------- | ------ | ---------------------------------------------------- |
| Delete fails in group (not admin)       | Medium     | Low    | Check admin status before delete, return clear error |
| React with unsupported emoji            | Low        | Low    | Catch Telegram error, return user-friendly message   |
| Forward between incompatible chat types | Low        | Low    | Validate target chat accessibility first             |

---

## Out of Scope

- Bulk operations (batch delete/forward) — future enhancement
- Scheduled messages
- Voice/video calls
- Telegram Premium features

---

## Testing

| Type | Description                   | File                                                               |
| ---- | ----------------------------- | ------------------------------------------------------------------ |
| Unit | Delete in DM with revoke      | `extensions/telegram-userbot/src/adapters/message-actions.test.ts` |
| Unit | Edit own message              | `extensions/telegram-userbot/src/adapters/message-actions.test.ts` |
| Unit | React to message              | `extensions/telegram-userbot/src/adapters/message-actions.test.ts` |
| Unit | Forward messages              | `extensions/telegram-userbot/src/adapters/message-actions.test.ts` |
| Unit | Pin message                   | `extensions/telegram-userbot/src/adapters/message-actions.test.ts` |
| Unit | Capability disabled rejection | `extensions/telegram-userbot/src/adapters/message-actions.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                          |
| -------------- | ------ | ------------------------------ |
| Research       | ~4k    | Study action adapter interface |
| Implementation | ~12k   | 6 actions + capability checks  |
| Testing        | ~4k    | Unit tests per action          |
| **Total**      | ~20k   | Straightforward adapter        |

---

## Subtasks

- [ ] 1.  Create `message-actions.ts` skeleton with supported actions list
- [ ] 2.  Implement `delete` action with revoke and capability check
- [ ] 3.  Implement `edit` action for own messages
- [ ] 4.  Implement `react` action with emoji parameter
- [ ] 5.  Implement `forward` action between chats
- [ ] 6.  Implement `pin` action (pin/unpin)
- [ ] 7.  Implement `topic-create` action for forum supergroups
- [ ] 8.  Wire adapter into plugin definition (TASK-06 integration)
- [ ] 9.  Write unit tests for each action with mocked client
