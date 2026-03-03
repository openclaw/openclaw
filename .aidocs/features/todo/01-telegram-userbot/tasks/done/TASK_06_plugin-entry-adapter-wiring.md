# TASK_06: Plugin Entry Point & Adapter Wiring

<!-- SUMMARY: Creates the main ChannelPlugin definition wiring all adapters together so OpenClaw recognizes telegram-userbot -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | complex             |
| **Est. Tokens** | ~35k                |
| **Priority**    | P0                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 2                   |
| **Wave**        | 2                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                                                                             |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §2 Proposed Solution (full section)                                                                                  |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §2 ChannelPlugin Contract, §3.1 Setup, §3.5 Status, §3.6 Auth/Security, §4 Module Structure, §6 Channel Registration |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-06                                                                                                              |

## Task Dependency Tree

```
TASK-01 (Client) ────────┐
TASK-03 (Connection) ────┤
TASK-05 (Config) ────────┤
                         ▼
    TASK-06 (Plugin Entry + Wiring) ←── you are here
                         │
                         ├──► TASK-07 (Inbound) — registers on plugin start
                         ├──► TASK-08 (Outbound) — wired as outbound adapter
                         ├──► TASK-09 (Actions) — wired as actions adapter
                         ├──► TASK-10 (Tools) — agent prompt adapter
                         ├──► TASK-11 (Streaming) — wired as streaming adapter
                         ├──► TASK-12 (Directory) — wired as directory adapter
                         ├──► TASK-13 (CLI Setup) — setup adapter
                         └──► TASK-14 (Monitoring) — status adapter
```

## Description

This is the central integration task. Create:

1. **`index.ts`** — Extension entry point with `register(api)` that calls `api.registerChannel()`
2. **`plugin.ts`** — `ChannelPlugin` definition wiring all adapters
3. **`runtime.ts`** — Runtime getter/setter pattern (standard for all extensions)
4. **Core adapters:** setup, auth, config, status, security — the minimum set needed for the plugin to load and register

Other adapters (outbound, inbound, actions, streaming, directory, threading, agent-prompt) are stubbed here and implemented in their respective tasks.

**Business value:** Makes telegram-userbot a fully functional channel in OpenClaw's plugin system, appearing in `openclaw channels list` and `openclaw status`.

---

## Context

### Related Files (from codebase research)

| File                                          | Purpose                          | Patterns to Follow                                              |
| --------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `extensions/discord/index.ts`                 | Discord extension entry          | `register(api)` → `api.registerChannel({ plugin })` pattern     |
| `extensions/discord/src/channel.ts`           | Discord ChannelPlugin definition | Full adapter wiring, capabilities declaration                   |
| `extensions/discord/src/runtime.ts`           | Discord runtime getter/setter    | Standard `set/get<Channel>Runtime()` pattern                    |
| `extensions/irc/src/channel.ts`               | IRC ChannelPlugin                | Simpler adapter wiring example                                  |
| `src/channels/plugins/types.plugin.ts`        | ChannelPlugin interface          | All adapter slots to fill                                       |
| `src/channels/plugins/types.adapters.ts`      | Adapter interfaces               | Setup, Config, Auth, Status, Security, Gateway, Outbound shapes |
| `src/channels/plugins/types.core.ts`          | Core types                       | ChannelCapabilities, ChannelMeta                                |
| `src/plugins/registry.ts`                     | Plugin registration              | registerChannel() implementation                                |
| `src/channels/plugins/onboarding-types.ts`    | Onboarding adapter               | Setup/config flow                                               |
| `src/channels/plugins/onboarding/telegram.ts` | Telegram bot onboarding          | Onboarding pattern to follow                                    |
| `extensions/googlechat/src/channel.ts`        | Google Chat plugin               | Gateway adapter with startAccount/stopAccount                   |

### Code Dependencies

- `openclaw/plugin-sdk` — types, helpers, runtime
- `UserbotClient` from TASK-01
- `ConnectionManager` from TASK-03
- Config schema from TASK-05

---

## Goals

1. Extension entry point (`index.ts`) that registers the channel plugin
2. Full `ChannelPlugin` definition with all required adapters
3. Runtime getter/setter for accessing OpenClaw runtime
4. Setup adapter: interactive phone + code + 2FA auth flow
5. Config adapter: account listing, resolution, enable/disable
6. Auth adapter: allowFrom enforcement
7. Status adapter: connection health for `openclaw status`
8. Security adapter: DM/group policies
9. Gateway adapter: startAccount/stopAccount lifecycle

---

## Acceptance Criteria

**AC-1: Plugin loads and registers**

- Given: Extension is in the extensions directory with valid manifest
- When: Plugin loader scans and loads extensions
- Then: `telegram-userbot` plugin registers successfully

**AC-2: Channel appears in list**

- Given: Plugin is registered
- When: `openclaw channels list` is run
- Then: Shows "Telegram (User)" with correct label and blurb

**AC-3: Setup adapter — interactive auth**

- Given: User runs `openclaw channels add --channel telegram-userbot`
- When: Setup flow begins
- Then: Prompts for apiId, apiHash, phone, code, and optional 2FA password

**AC-4: Config adapter — account management**

- Given: Channel is configured with valid config
- When: Account resolution is requested
- Then: Returns resolved account with apiId, apiHash, session info

**AC-5: Auth adapter — allowFrom enforcement**

- Given: Config has `allowFrom: [267619672]`
- When: Message from user 999999 arrives
- Then: Auth adapter rejects the message

**AC-6: Status adapter — connection health**

- Given: Client is connected
- When: `openclaw status` or `openclaw channels status` is run
- Then: Shows `telegram-userbot: ✓ connected (@username, uptime Xh, DCY)`

**AC-7: Gateway adapter — start/stop lifecycle**

- Given: Plugin is loaded and config exists
- When: Gateway starts account
- Then: ConnectionManager starts, client connects, event handlers registered

**AC-8: Capabilities declared**

- Given: Plugin definition
- When: Capabilities are checked
- Then: Reports support for: text, media (photo, document, voice, video), delete, edit, react, forward, pin, threads (topics)

---

## Dependencies

**Depends on:**

- TASK-01 (Client) — UserbotClient used by gateway adapter
- TASK-03 (Connection Manager) — lifecycle management in gateway adapter
- TASK-05 (Config Schema) — Zod schema + meta for plugin definition

**Blocks:**

- TASK-07 through TASK-14 — all depend on the plugin being registered

---

## Files to Change

| Action | File                                                   | Scope                                      |
| ------ | ------------------------------------------------------ | ------------------------------------------ |
| CREATE | `extensions/telegram-userbot/index.ts`                 | Extension entry: register(api)             |
| CREATE | `extensions/telegram-userbot/src/channel.ts`           | ChannelPlugin definition with all adapters |
| CREATE | `extensions/telegram-userbot/src/runtime.ts`           | Runtime getter/setter                      |
| CREATE | `extensions/telegram-userbot/src/adapters/setup.ts`    | Setup adapter (interactive auth)           |
| CREATE | `extensions/telegram-userbot/src/adapters/auth.ts`     | Auth adapter (allowFrom)                   |
| CREATE | `extensions/telegram-userbot/src/adapters/config.ts`   | Config adapter (account management)        |
| CREATE | `extensions/telegram-userbot/src/adapters/status.ts`   | Status adapter (health reporting)          |
| CREATE | `extensions/telegram-userbot/src/adapters/security.ts` | Security adapter (DM/group policies)       |
| CREATE | `extensions/telegram-userbot/src/channel.test.ts`      | Plugin registration and adapter tests      |

---

## Risks & Mitigations

| Risk                                                | Likelihood | Impact | Mitigation                                              |
| --------------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| Plugin loader doesn't discover extension            | Medium     | High   | Follow exact manifest/package.json pattern from Discord |
| Adapter interface changes between OpenClaw versions | Low        | Medium | Pin to current interface, test with plugin tests        |
| Circular dependency between adapters                | Medium     | Medium | Use lazy imports, dependency injection via runtime      |

---

## Out of Scope

- Outbound adapter implementation (TASK-08)
- Inbound message handler (TASK-07)
- Message actions adapter (TASK-09)
- Streaming, threading, directory adapters (TASK-11, TASK-12)
- Agent prompt adapter (TASK-10)
- Full CLI setup wizard UX (TASK-13)

---

## Testing

| Type        | Description                                  | File                                              |
| ----------- | -------------------------------------------- | ------------------------------------------------- |
| Unit        | Plugin object has all required adapter slots | `extensions/telegram-userbot/src/channel.test.ts` |
| Unit        | Config adapter resolves accounts             | `extensions/telegram-userbot/src/channel.test.ts` |
| Unit        | Auth adapter enforces allowFrom              | `extensions/telegram-userbot/src/channel.test.ts` |
| Unit        | Capabilities correctly declared              | `extensions/telegram-userbot/src/channel.test.ts` |
| Integration | Plugin loads via extension loader            | `extensions/telegram-userbot/src/channel.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                                |
| -------------- | ------ | ---------------------------------------------------- |
| Research       | ~8k    | Study Discord/IRC/GChat plugin definitions in detail |
| Implementation | ~20k   | Plugin def, 5 adapters, entry point, runtime         |
| Testing        | ~7k    | Unit + integration tests                             |
| **Total**      | ~35k   | Largest single task                                  |

---

## Subtasks

- [ ] 1.  Create `runtime.ts` with set/getTelegramUserbotRuntime()
- [ ] 2.  Create `index.ts` extension entry with register(api)
- [ ] 3.  Create `openclaw.plugin.json` manifest (if not done in TASK-05)
- [ ] 4.  Create `channel.ts` with ChannelPlugin skeleton (id, meta, capabilities)
- [ ] 5.  Implement config adapter (listAccountIds, resolveAccount, enable/disable)
- [ ] 6.  Implement auth adapter (allowFrom enforcement)
- [ ] 7.  Implement setup adapter (interactive phone + code + 2FA flow)
- [ ] 8.  Implement status adapter (connection health, probe, snapshot)
- [ ] 9.  Implement security adapter (DM/group policies)
- [ ] 10. Implement gateway adapter (startAccount, stopAccount)
- [ ] 11. Wire all adapters into ChannelPlugin definition
- [ ] 12. Write unit tests for plugin registration and each adapter
