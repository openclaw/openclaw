# TASK_01: GramJS Client Wrapper

<!-- SUMMARY: Provides the foundational GramJS MTProto client abstraction enabling all userbot channel operations -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~25k                |
| **Priority**    | P0                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 1                   |
| **Wave**        | 1                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                                   |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §2 Proposed Solution, §7 Constraints                                       |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.2 Outbound, §4 Module Structure, §8.1 Peer Resolution, §14 Dependencies |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-01                                                                    |

## Task Dependency Tree

```
TASK-01 (GramJS Client) <-- you are here
   |
   |---> TASK-03 (Connection Manager) -- uses client
   |---> TASK-06 (Plugin Entry) -- wires client
   |---> TASK-07 (Inbound Handler) -- receives via client
   |---> TASK-08 (Outbound Adapter) -- sends via client
   |---> TASK-11 (Streaming) -- typing via client
   +---> TASK-12 (Directory) -- resolves via client
```

## Description

Create a `UserbotClient` class that wraps the GramJS `TelegramClient` and exposes all message operations needed by the channel adapters. This is the lowest-level building block — everything else depends on it.

The wrapper must:

1. Initialize GramJS with `StringSession` (for persistence)
2. Expose typed methods for every Telegram user API operation OpenClaw needs
3. Handle peer resolution (numeric ID, @username, OpenClaw target format)
4. Wrap GramJS errors into typed OpenClaw errors
5. Support both session-based connect and interactive auth (for setup wizard)

**Business value:** Enables sending messages as a real user account, bypassing Bot API limitations (SC-1 through SC-8 from spec).

---

## Context

### Related Files (from codebase research)

| File                                     | Purpose                              | Patterns to Follow                                          |
| ---------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `extensions/discord/src/channel.ts`      | Discord channel plugin with outbound | Outbound adapter pattern, how send functions are structured |
| `extensions/irc/src/channel.ts`          | IRC channel plugin                   | Simple client lifecycle pattern                             |
| `extensions/telegram/`                   | Existing Telegram bot extension      | Bot API patterns (contrast with userbot)                    |
| `src/channels/plugins/types.adapters.ts` | Adapter type definitions             | OutboundAdapter interface shape                             |
| `src/channels/plugins/types.core.ts`     | Core channel types                   | ChannelCapabilities, action types                           |
| `extensions/test-utils/runtime-env.ts`   | Test runtime helpers                 | vi.fn() mock patterns                                       |

### Code Dependencies

- `telegram` (GramJS) — MTProto client library
- `telegram/sessions` — `StringSession` for session persistence
- `telegram/tl/api` — Telegram API types (`Api.Message`, `Api.TypeInputPeer`, etc.)
- `big-integer` — transitive dep of GramJS

---

## Goals

1. `UserbotClient` class wrapping `TelegramClient` with all needed message operations
2. Typed peer resolution supporting numeric IDs, @usernames, and OpenClaw target format
3. Error wrapping converting GramJS exceptions to typed OpenClaw errors
4. Full unit test coverage with mocked GramJS client

---

## Acceptance Criteria

**AC-1: Client initialization**

- Given: Valid apiId, apiHash, and session string
- When: `new UserbotClient(config)` is created and `connect()` is called
- Then: GramJS TelegramClient connects via MTProto with the session

**AC-2: Interactive authentication**

- Given: apiId, apiHash, and phone number (no existing session)
- When: `connectInteractive({ apiId, apiHash, phone, codeCallback, passwordCallback })` is called
- Then: Auth flow completes, session string is available via `getSessionString()`

**AC-3: Core message operations**

- Given: Connected client
- When: `sendMessage()`, `sendFile()`, `editMessage()`, `deleteMessages()`, `forwardMessages()`, `reactToMessage()`, `pinMessage()`, `getHistory()`, `setTyping()` are called
- Then: Each correctly invokes the corresponding GramJS method and returns typed results

**AC-4: Peer resolution**

- Given: chatId as number (267619672), string ("@username"), or OpenClaw format ("telegram-userbot:267619672")
- When: `resolvePeer(chatId)` is called
- Then: Returns the correct `Api.TypeInputPeer`

**AC-5: Error handling**

- Given: GramJS throws `FloodWaitError`, `AuthKeyError`, or generic `RPCError`
- When: Any client method catches the error
- Then: Error is wrapped in typed `UserbotError` with code, message, and retryAfter (if applicable)

**AC-6: Connection state**

- Given: Client instance
- When: `isConnected()`, `getMe()`, `disconnect()` are called
- Then: Returns accurate connection state, user info, and cleanly disconnects

---

## Dependencies

**Depends on:**

- None (foundation task)

**Blocks:**

- TASK-03 (Connection Manager) — uses client for connect/disconnect/health
- TASK-06 (Plugin Entry) — wires client into plugin adapters
- TASK-07 (Inbound Handler) — registers event handlers on client
- TASK-08 (Outbound Adapter) — calls client send methods
- TASK-11 (Streaming) — calls client setTyping
- TASK-12 (Directory) — calls client getDialogs/getEntity

---

## Files to Change

| Action | File                                             | Scope                                                                 |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/client.ts`      | UserbotClient class with all message ops                              |
| CREATE | `extensions/telegram-userbot/src/types.ts`       | TypeScript interfaces (UserbotConfig, UserbotError, SendResult, etc.) |
| CREATE | `extensions/telegram-userbot/src/errors.ts`      | Error types and GramJS error wrapping                                 |
| CREATE | `extensions/telegram-userbot/src/peer.ts`        | Peer resolution helpers                                               |
| CREATE | `extensions/telegram-userbot/src/client.test.ts` | Unit tests with mocked GramJS                                         |

---

## Risks & Mitigations

| Risk                                   | Likelihood | Impact | Mitigation                                                  |
| -------------------------------------- | ---------- | ------ | ----------------------------------------------------------- |
| GramJS API changes                     | Low        | Medium | Pin `telegram` package version, check changelog             |
| TypeScript type mismatches with GramJS | Medium     | Low    | Use `@ts-expect-error` sparingly, contribute types upstream |
| Entity cache inconsistency             | Medium     | Low    | Invalidate cache on disconnect, lazy re-resolve             |

---

## Out of Scope

- Connection management / reconnection logic (TASK-03)
- Rate limiting / flood control (TASK-04)
- Session persistence to disk (TASK-02)
- Plugin registration and adapter wiring (TASK-06)

---

## Testing

| Type | Description                                                  | File                                             |
| ---- | ------------------------------------------------------------ | ------------------------------------------------ |
| Unit | Client initialization and connect with mocked TelegramClient | `extensions/telegram-userbot/src/client.test.ts` |
| Unit | All message operations delegate to correct GramJS methods    | `extensions/telegram-userbot/src/client.test.ts` |
| Unit | Peer resolution for all input formats                        | `extensions/telegram-userbot/src/peer.test.ts`   |
| Unit | Error wrapping for FloodWait, AuthKey, RPC errors            | `extensions/telegram-userbot/src/errors.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                        |
| -------------- | ------ | -------------------------------------------- |
| Research       | ~5k    | Read GramJS API, existing channel patterns   |
| Implementation | ~15k   | Client class, types, errors, peer resolution |
| Testing        | ~5k    | Unit tests with mocks                        |
| **Total**      | ~25k   | Well under 100k limit                        |

---

## Subtasks

- [ ] 1.  Create `types.ts` with UserbotConfig, SendResult, UserbotError interfaces
- [ ] 2.  Create `errors.ts` with error wrapping (FloodWaitError -> UserbotFloodError, etc.)
- [ ] 3.  Create `peer.ts` with resolvePeer supporting numeric, @username, OpenClaw format
- [ ] 4.  Create `client.ts` with UserbotClient class (constructor, connect, connectInteractive)
- [ ] 5.  Implement all message operations on UserbotClient (send, sendFile, edit, delete, forward, react, pin, getHistory, setTyping)
- [ ] 6.  Implement getMe(), isConnected(), disconnect(), getSessionString()
- [ ] 7.  Write unit tests for client with mocked GramJS TelegramClient
- [ ] 8.  Write unit tests for peer resolution
- [ ] 9.  Write unit tests for error wrapping
