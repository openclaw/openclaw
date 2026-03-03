# TASK_03: Connection Manager

<!-- SUMMARY: Manages GramJS client lifecycle with auto-reconnection ensuring the userbot stays connected reliably -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~20k                |
| **Priority**    | P0                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 1                   |
| **Wave**        | 2                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                                        |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 SC-10 (Session persistence), §5 Risks (session invalidation, MTProto issues) |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §9 Connection Lifecycle, §5 Configuration (reconnect section)                   |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-03                                                                         |

## Task Dependency Tree

```
TASK-01 (Client) --------+
TASK-02 (Session) -------+
                         v
              TASK-03 (Connection Mgr) <-- you are here
                         |
                         |---> TASK-06 (Plugin Entry) -- gateway adapter uses connection
                         +---> TASK-14 (Monitoring) -- health metrics from connection
```

## Description

Create a `ConnectionManager` that orchestrates the GramJS client lifecycle:

1. Load session from SessionStore -> connect UserbotClient -> register keepalive
2. Handle disconnects with configurable retry strategy (immediate -> 5s -> 30s -> 2min)
3. Emit events for connection state changes (`connected`, `disconnected`, `reconnecting`, `authError`)
4. Provide health metrics (uptime, reconnect count, latency)
5. Handle `AUTH_KEY_UNREGISTERED` as a fatal auth error

**Business value:** Ensures the userbot channel stays reliably connected, recovering from transient network issues automatically (supports all success criteria by keeping the channel operational).

---

## Context

### Related Files (from codebase research)

| File                                                | Purpose                   | Patterns to Follow                                            |
| --------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `extensions/discord/src/channel.ts`                 | Discord gateway adapter   | startAccount/stopAccount lifecycle                            |
| `extensions/irc/src/channel.ts`                     | IRC connection management | Reconnection patterns                                         |
| `src/channels/plugins/types.adapters.ts`            | Gateway adapter type      | `ChannelGatewayAdapter` interface (startAccount, stopAccount) |
| `extensions/googlechat/src/channel.startup.test.ts` | Gateway startup test      | Testing connection lifecycle                                  |

### Code Dependencies

- `UserbotClient` from TASK-01
- `SessionStore` from TASK-02
- `node:events` — EventEmitter for connection events

---

## Goals

1. Full connection lifecycle: start -> session load -> connect -> keepalive -> stop
2. Reconnection strategy with configurable backoff: immediate(1x) -> 5s(2x) -> 30s(3x) -> 2min(infinite)
3. Event-based state notifications for other components
4. Health metrics: connected, latency, uptime, reconnect count

---

## Acceptance Criteria

**AC-1: Happy path start**

- Given: Valid config and existing session file
- When: `start(config)` is called
- Then: Session is loaded, client connects, `connected` event is emitted

**AC-2: Missing session on start**

- Given: No session file for this account
- When: `start(config)` is called
- Then: Logs warning "Run `openclaw channels add --channel telegram-userbot`", does not attempt connection

**AC-3: Reconnection strategy**

- Given: Client is connected and then disconnects
- When: Disconnect is detected
- Then: Retries with the configured backoff schedule: immediate -> 5s(2x) -> 30s(3x) -> 2min(infinite)

**AC-4: Auth error handling**

- Given: Client throws `AUTH_KEY_UNREGISTERED`
- When: Connection attempt fails with this error
- Then: Stops retrying, emits `authError`, marks as disconnected

**AC-5: Graceful stop**

- Given: Client is connected
- When: `stop()` is called
- Then: Client disconnects, session is saved, cleanup is performed

**AC-6: Health reporting**

- Given: Connection manager in any state
- When: `health()` is called
- Then: Returns `{ connected, latency, uptime, reconnects, dcId }`

**AC-7: Alert after N failures**

- Given: Config has `reconnect.alertAfterFailures: 3`
- When: 3 consecutive reconnection failures occur
- Then: `alertNeeded` event is emitted with failure count

---

## Dependencies

**Depends on:**

- TASK-01 (Client) — UserbotClient for connect/disconnect
- TASK-02 (Session) — SessionStore for load/save

**Blocks:**

- TASK-06 (Plugin Entry) — gateway adapter wraps ConnectionManager
- TASK-14 (Monitoring) — reads health metrics

---

## Files to Change

| Action | File                                                 | Scope                                     |
| ------ | ---------------------------------------------------- | ----------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/connection.ts`      | ConnectionManager class                   |
| CREATE | `extensions/telegram-userbot/src/connection.test.ts` | Unit tests with mocked client and session |

---

## Risks & Mitigations

| Risk                                        | Likelihood | Impact | Mitigation                                              |
| ------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| Infinite reconnect loop consuming resources | Low        | Medium | Exponential backoff, max 2min interval                  |
| Race condition between stop and reconnect   | Medium     | Low    | Use mutex/flag to prevent reconnect after explicit stop |
| Memory leak from abandoned timers           | Low        | Medium | Clear all timers on stop(), use AbortController         |

---

## Out of Scope

- Interactive authentication flow (handled by TASK-13 CLI Setup via TASK-01)
- Flood control (TASK-04)
- Inbound/outbound message handling (TASK-07, TASK-08)

---

## Testing

| Type | Description                                                 | File                                                 |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------- |
| Unit | Happy path start: load session -> connect -> emit connected | `extensions/telegram-userbot/src/connection.test.ts` |
| Unit | Missing session logs warning                                | `extensions/telegram-userbot/src/connection.test.ts` |
| Unit | Reconnection backoff timing                                 | `extensions/telegram-userbot/src/connection.test.ts` |
| Unit | AUTH_KEY_UNREGISTERED stops retrying                        | `extensions/telegram-userbot/src/connection.test.ts` |
| Unit | Graceful stop clears timers                                 | `extensions/telegram-userbot/src/connection.test.ts` |
| Unit | Health metrics accuracy                                     | `extensions/telegram-userbot/src/connection.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                    |
| -------------- | ------ | ---------------------------------------- |
| Research       | ~4k    | Study Discord/IRC gateway patterns       |
| Implementation | ~12k   | ConnectionManager class with retry logic |
| Testing        | ~4k    | Unit tests with fake timers              |
| **Total**      | ~20k   | Under 100k limit                         |

---

## Subtasks

- [ ] 1.  Create `connection.ts` with ConnectionManager class skeleton (start, stop, restart, health)
- [ ] 2.  Implement session loading via SessionStore in start()
- [ ] 3.  Implement reconnection strategy with configurable backoff delays
- [ ] 4.  Implement EventEmitter for connected/disconnected/reconnecting/authError events
- [ ] 5.  Handle AUTH_KEY_UNREGISTERED as fatal error
- [ ] 6.  Implement health() returning ConnectionHealth metrics
- [ ] 7.  Implement alert-after-N-failures logic
- [ ] 8.  Write unit tests with mocked UserbotClient and SessionStore using fake timers
