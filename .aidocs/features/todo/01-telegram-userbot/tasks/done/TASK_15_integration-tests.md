# TASK_15: Integration Tests

<!-- SUMMARY: End-to-end test suite validating the complete telegram-userbot channel works correctly across all components -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~20k                |
| **Priority**    | P1                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 5                   |
| **Wave**        | 5                   |

---

## SDD References

| Document  | Path                                                               | Sections                     |
| --------- | ------------------------------------------------------------------ | ---------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 Success Criteria (all 12) |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §13 Testing Strategy         |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-15                      |

## Task Dependency Tree

```
ALL TASKS (01-14) ───┐
                     ▼
        TASK-15 (Integration Tests) ←── you are here
                     │
                     └──► TASK-16 (Documentation) — tests inform docs
```

## Description

Create a comprehensive integration test suite covering:

1. **Connection lifecycle:** connect → disconnect → reconnect → auth error
2. **Inbound flow:** MTProto event → InboundMessage → gateway routing
3. **Outbound flow:** Agent reply → outbound adapter → GramJS send → Telegram
4. **Actions:** delete, react, forward, pin via message actions adapter
5. **Flood control:** Concurrent sends respect rate limits
6. **Config:** Enable/disable, validation errors, missing config
7. **Fallback:** Graceful handling when disconnected
8. **Allow list:** Blocked users' messages ignored

Tests are split into:

- **Unit-level integration tests** — run in CI, use mocked GramJS client
- **Live integration tests** — skip in CI, use real Telegram account (manual)

**Business value:** Ensures all 12 success criteria from the spec are verified, preventing regressions as the codebase evolves.

---

## Context

### Related Files (from codebase research)

| File                                                | Purpose               | Patterns to Follow                      |
| --------------------------------------------------- | --------------------- | --------------------------------------- |
| `vitest.config.ts`                                  | Base Vitest config    | Test runner setup                       |
| `vitest.extensions.config.ts`                       | Extension test config | How extension tests are configured      |
| `vitest.e2e.config.ts`                              | E2E test config       | End-to-end test patterns                |
| `vitest.live.config.ts`                             | Live test config      | Real-account test patterns              |
| `vitest.gateway.config.ts`                          | Gateway test config   | Gateway integration patterns            |
| `extensions/discord/src/channel.test.ts`            | Discord channel tests | Mocked runtime, outbound testing        |
| `extensions/googlechat/src/channel.startup.test.ts` | Gateway startup tests | vi.mock, GatewayContext mocking         |
| `extensions/test-utils/runtime-env.ts`              | Runtime test env      | createRuntimeEnv() with vi.fn() stubs   |
| `src/channels/plugins/plugins-channel.test.ts`      | Shared plugin tests   | Target normalization, outbound behavior |
| `extensions/irc/src/config-schema.test.ts`          | Config schema tests   | Zod schema validation testing           |

### Code Dependencies

- `vitest` (^4.0.18) — test framework
- `extensions/test-utils/runtime-env.ts` — mock runtime creation
- All telegram-userbot modules (TASK-01 through TASK-14)

---

## Goals

1. Integration tests covering all component interactions (mocked GramJS)
2. Live test stubs for manual testing with real account
3. Coverage of all 12 success criteria from spec
4. Regression safety for future changes

---

## Acceptance Criteria

**AC-1: Connection lifecycle tests**

- Given: Mocked GramJS client
- When: Tests run connect → disconnect → reconnect → auth error scenarios
- Then: All pass with correct state transitions verified

**AC-2: Inbound message flow tests**

- Given: Mocked GramJS events (NewMessage, MessageEdited)
- When: Events are fired
- Then: Correct InboundMessages reach the gateway mock

**AC-3: Outbound message flow tests**

- Given: Outbound send request
- When: sendText/sendMedia are called
- Then: GramJS client methods called with correct params, flood control respected

**AC-4: Message actions tests**

- Given: Action requests (delete, edit, react, forward, pin)
- When: Actions are executed
- Then: Correct GramJS methods called, capability checks work

**AC-5: Flood control integration tests**

- Given: Rate-limited FloodController
- When: Multiple concurrent sends attempted
- Then: Sends are properly throttled and sequenced

**AC-6: Config validation tests**

- Given: Various config inputs (valid, invalid, partial, missing)
- When: Config is parsed
- Then: Correct validation results with helpful error messages

**AC-7: Fallback behavior tests**

- Given: Client is disconnected
- When: Outbound send is attempted
- Then: Error is returned (not thrown), fallback behavior is clean

**AC-8: AllowFrom tests**

- Given: AllowFrom list configured
- When: Message from unlisted user arrives
- Then: Message is silently dropped

---

## Dependencies

**Depends on:**

- All tasks TASK-01 through TASK-14

**Blocks:**

- TASK-16 (Documentation) — test results inform troubleshooting docs

---

## Files to Change

| Action | File                                                  | Scope                             |
| ------ | ----------------------------------------------------- | --------------------------------- |
| CREATE | `extensions/telegram-userbot/src/integration.test.ts` | Main integration test suite       |
| CREATE | `extensions/telegram-userbot/src/live.test.ts`        | Live tests (manual, real account) |
| CREATE | `extensions/telegram-userbot/src/test-helpers.ts`     | Shared test mocks and fixtures    |

---

## Risks & Mitigations

| Risk                                    | Likelihood | Impact | Mitigation                               |
| --------------------------------------- | ---------- | ------ | ---------------------------------------- |
| Flaky tests from timing issues          | Medium     | Medium | Use fake timers, avoid real delays       |
| Live tests break due to account state   | Medium     | Low    | Skip in CI, document manual steps        |
| Mock diverges from real GramJS behavior | Low        | Medium | Periodically verify against real account |

---

## Out of Scope

- Performance/load testing
- Chaos engineering (random disconnects)
- Cross-channel interaction tests (userbot + bot simultaneously)
- Automated E2E with two real Telegram accounts

---

## Testing

| Type        | Description                                         | File                                                  |
| ----------- | --------------------------------------------------- | ----------------------------------------------------- |
| Integration | Connection lifecycle (connect/disconnect/reconnect) | `extensions/telegram-userbot/src/integration.test.ts` |
| Integration | Inbound message flow (event → gateway)              | `extensions/telegram-userbot/src/integration.test.ts` |
| Integration | Outbound message flow (send → GramJS)               | `extensions/telegram-userbot/src/integration.test.ts` |
| Integration | Message actions (delete/edit/react/forward/pin)     | `extensions/telegram-userbot/src/integration.test.ts` |
| Integration | Flood control under concurrent load                 | `extensions/telegram-userbot/src/integration.test.ts` |
| Integration | Config validation (valid/invalid/partial)           | `extensions/telegram-userbot/src/integration.test.ts` |
| Integration | Fallback when disconnected                          | `extensions/telegram-userbot/src/integration.test.ts` |
| Integration | AllowFrom filtering                                 | `extensions/telegram-userbot/src/integration.test.ts` |
| Live        | Send/receive real message                           | `extensions/telegram-userbot/src/live.test.ts`        |
| Live        | Delete real message                                 | `extensions/telegram-userbot/src/live.test.ts`        |

---

## Estimated Context

| Phase          | Tokens | Notes                          |
| -------------- | ------ | ------------------------------ |
| Research       | ~4k    | Study existing test patterns   |
| Implementation | ~12k   | Integration + live test suites |
| Testing        | ~4k    | Run and verify all tests pass  |
| **Total**      | ~20k   | Comprehensive test suite       |

---

## Subtasks

- [ ] 1.  Create `test-helpers.ts` with shared mocks (GramJS client, session store, runtime)
- [ ] 2.  Write connection lifecycle integration tests
- [ ] 3.  Write inbound message flow integration tests
- [ ] 4.  Write outbound message flow integration tests
- [ ] 5.  Write message actions integration tests
- [ ] 6.  Write flood control integration tests
- [ ] 7.  Write config validation integration tests
- [ ] 8.  Write fallback/disconnected behavior tests
- [ ] 9.  Write allowFrom filtering tests
- [ ] 10. Create `live.test.ts` stubs for manual testing with real account
