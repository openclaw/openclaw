# TASK_12: Directory & Threading Adapters

<!-- SUMMARY: Enables contact/chat resolution and forum topic support for the userbot channel -->

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

| Document  | Path                                                               | Sections                                         |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 SC-5 (Read chat history)                      |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.8 Directory Adapter, §3.4 topic-create action |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-12                                          |

## Task Dependency Tree

```
TASK-01 (Client) ────┐
TASK-06 (Plugin) ────┤
                     ▼
        TASK-12 (Directory + Threading) ←── you are here
```

## Description

Implement two adapters:

**Directory Adapter (`ChannelDirectoryAdapter`):**

- List recent dialogs (chats the user has active conversations with)
- Resolve username → peer entity
- Search contacts by name
- Get self user info

**Threading Adapter (`ChannelThreadingAdapter`):**

- Support forum topics in supergroups with topics enabled
- Reply within specific topic threads
- Map topic IDs to thread context

**Business value:** Enables the agent to discover and resolve chat targets (needed for forwarding, SC-7) and supports Telegram's forum topic feature for organized group conversations.

---

## Context

### Related Files (from codebase research)

| File                                                | Purpose                             | Patterns to Follow                            |
| --------------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| `src/channels/plugins/types.adapters.ts` (line 271) | `ChannelDirectoryAdapter` interface | self, listPeers, listGroups, listGroupMembers |
| `src/channels/plugins/types.core.ts` (line 222)     | `ChannelThreadingAdapter` interface | replyToMode, buildToolContext                 |
| `extensions/discord/src/channel.ts`                 | Discord directory/threading         | Existing adapter patterns                     |

### Code Dependencies

- `UserbotClient` from TASK-01 — getDialogs, getEntity, contacts.Search
- `telegram/tl/api` — `Api.contacts.Search`, `Api.messages.GetDialogs`

---

## Goals

1. Directory adapter: list dialogs, resolve usernames, search contacts
2. Threading adapter: forum topic support, reply-in-thread
3. Self info resolution for the connected account

---

## Acceptance Criteria

**AC-1: List recent dialogs**

- Given: User has active conversations
- When: `listPeers()` is called
- Then: Returns list of recent chats with name, ID, type, last activity

**AC-2: Resolve username**

- Given: A Telegram @username
- When: `resolveTarget("@username")` is called (via directory)
- Then: Returns the peer entity with user ID and display name

**AC-3: Search contacts**

- Given: Search query "John"
- When: Contact search is performed
- Then: Returns matching contacts from the user's contact list

**AC-4: Self info**

- Given: Connected userbot
- When: `self()` is called
- Then: Returns current user's ID, username, name, phone

**AC-5: Forum topic threading**

- Given: Supergroup with topics enabled
- When: Message arrives in a topic thread
- Then: Thread context includes topic ID and topic name

**AC-6: Reply in topic**

- Given: Agent replies in a topic-enabled supergroup
- When: Reply is sent
- Then: Message is sent within the correct topic thread

---

## Dependencies

**Depends on:**

- TASK-01 (Client) — getDialogs, getEntity, contacts API
- TASK-06 (Plugin Entry) — adapter wiring

**Blocks:**

- None directly (enhances overall capability)

---

## Files to Change

| Action | File                                                         | Scope                                  |
| ------ | ------------------------------------------------------------ | -------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/adapters/directory.ts`      | ChannelDirectoryAdapter implementation |
| CREATE | `extensions/telegram-userbot/src/adapters/threading.ts`      | ChannelThreadingAdapter implementation |
| CREATE | `extensions/telegram-userbot/src/adapters/directory.test.ts` | Unit tests for directory               |
| CREATE | `extensions/telegram-userbot/src/adapters/threading.test.ts` | Unit tests for threading               |

---

## Risks & Mitigations

| Risk                                   | Likelihood | Impact | Mitigation                                 |
| -------------------------------------- | ---------- | ------ | ------------------------------------------ |
| Large dialog list causes slow response | Low        | Low    | Limit to most recent 100 dialogs, paginate |
| Username resolution hits rate limit    | Low        | Low    | Cache resolved entities                    |
| Topic ID format changes                | Low        | Low    | Use GramJS typed API calls                 |

---

## Out of Scope

- Full address book sync
- Group member management (kick, ban, promote)
- Channel post management
- Contact import/export

---

## Testing

| Type | Description                              | File                                                         |
| ---- | ---------------------------------------- | ------------------------------------------------------------ |
| Unit | List dialogs returns formatted peer list | `extensions/telegram-userbot/src/adapters/directory.test.ts` |
| Unit | Username resolution                      | `extensions/telegram-userbot/src/adapters/directory.test.ts` |
| Unit | Contact search                           | `extensions/telegram-userbot/src/adapters/directory.test.ts` |
| Unit | Self info                                | `extensions/telegram-userbot/src/adapters/directory.test.ts` |
| Unit | Topic thread context building            | `extensions/telegram-userbot/src/adapters/threading.test.ts` |
| Unit | Reply in topic                           | `extensions/telegram-userbot/src/adapters/threading.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                |
| -------------- | ------ | ------------------------------------ |
| Research       | ~4k    | Study directory/threading interfaces |
| Implementation | ~12k   | Two adapters                         |
| Testing        | ~4k    | Unit tests for both                  |
| **Total**      | ~20k   | Two related adapters                 |

---

## Subtasks

- [ ] 1.  Create `directory.ts` with ChannelDirectoryAdapter skeleton
- [ ] 2.  Implement `self()` — current user info via client.getMe()
- [ ] 3.  Implement `listPeers()` — recent dialogs via client.getDialogs()
- [ ] 4.  Implement username resolution via client.getEntity()
- [ ] 5.  Implement contact search via contacts.Search API
- [ ] 6.  Create `threading.ts` with ChannelThreadingAdapter
- [ ] 7.  Implement forum topic detection and thread context
- [ ] 8.  Implement reply-in-topic for messages in topic supergroups
- [ ] 9.  Write unit tests for directory adapter
- [ ] 10. Write unit tests for threading adapter
