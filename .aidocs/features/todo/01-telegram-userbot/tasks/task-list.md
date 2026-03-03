# Telegram Userbot Channel — Task List

**Feature:** 01-telegram-userbot
**Total Tasks:** 16
**Total Estimated Tokens:** ~260k
**Created:** 2026-03-02

---

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    EXECUTION DEPENDENCY GRAPH                     │
│                                                                  │
│  Wave 1 (parallel, no deps):                                    │
│    TASK-01 (Client)  TASK-02 (Session)  TASK-04 (Flood)         │
│    TASK-05 (Config)                                              │
│         │                │                  │                    │
│         └────────┬───────┘                  │                    │
│  Wave 2:         ▼                          │                    │
│         TASK-03 (Connection)                │                    │
│         TASK-06 (Plugin Entry) ◄────────────┘                    │
│              │        │                                          │
│  Wave 3:     ▼        ▼                                          │
│      TASK-07 (In)  TASK-08 (Out) ◄── TASK-04 (Flood)           │
│              │        │                                          │
│              └───┬────┘                                          │
│  Wave 3:         ▼                                               │
│      TASK-09 (Actions)  TASK-11 (Streaming)  TASK-12 (Dir+Thr) │
│         │                                                        │
│         ▼                                                        │
│      TASK-10 (Tools)                                             │
│                                                                  │
│  Wave 4:                                                         │
│      TASK-13 (CLI Setup)  TASK-14 (Monitoring)                  │
│                                                                  │
│  Wave 5:                                                         │
│      TASK-15 (Integration Tests)  TASK-16 (Documentation)       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Core Infrastructure (~70k tokens)

| #   | Task                                                           | Complexity | Tokens | Priority | Wave | Depends On | Status |
| --- | -------------------------------------------------------------- | ---------- | ------ | -------- | ---- | ---------- | ------ |
| 01  | [GramJS Client Wrapper](todo/TASK_01_gramjs-client-wrapper.md) | normal     | ~25k   | P0       | 1    | —          | todo   |
| 02  | [Session Store](todo/TASK_02_session-store.md)                 | simple     | ~10k   | P0       | 1    | —          | todo   |
| 03  | [Connection Manager](todo/TASK_03_connection-manager.md)       | normal     | ~20k   | P0       | 2    | 01, 02     | todo   |
| 04  | [Flood Control](todo/TASK_04_flood-control.md)                 | normal     | ~15k   | P0       | 1    | —          | todo   |

**Parallelizable:** TASK-01, TASK-02, TASK-04 can run simultaneously. TASK-03 waits for 01+02.

---

## Phase 2: Channel Plugin Registration (~110k tokens)

| #   | Task                                                                         | Complexity | Tokens | Priority | Wave | Depends On | Status |
| --- | ---------------------------------------------------------------------------- | ---------- | ------ | -------- | ---- | ---------- | ------ |
| 05  | [Config Schema & Registration](todo/TASK_05_config-schema-registration.md)   | normal     | ~15k   | P0       | 1    | —          | todo   |
| 06  | [Plugin Entry & Adapter Wiring](todo/TASK_06_plugin-entry-adapter-wiring.md) | complex    | ~35k   | P0       | 2    | 01, 03, 05 | todo   |
| 07  | [Inbound Message Handler](todo/TASK_07_inbound-message-handler.md)           | complex    | ~30k   | P0       | 3    | 01, 06     | todo   |
| 08  | [Outbound Adapter](todo/TASK_08_outbound-adapter.md)                         | complex    | ~30k   | P0       | 3    | 01, 04, 06 | todo   |

**Parallelizable:** TASK-05 can run with Wave 1. TASK-07 and TASK-08 can run simultaneously after TASK-06.

---

## Phase 3: Message Actions & Tools (~65k tokens)

| #   | Task                                                                           | Complexity | Tokens | Priority | Wave | Depends On | Status |
| --- | ------------------------------------------------------------------------------ | ---------- | ------ | -------- | ---- | ---------- | ------ |
| 09  | [Message Actions Adapter](todo/TASK_09_message-actions-adapter.md)             | normal     | ~20k   | P1       | 3    | 08         | todo   |
| 10  | [Extended Tool Capabilities](todo/TASK_10_extended-tool-capabilities.md)       | normal     | ~15k   | P1       | 3    | 09         | todo   |
| 11  | [Streaming & Typing Adapter](todo/TASK_11_streaming-typing-adapter.md)         | simple     | ~10k   | P2       | 3    | 01, 06     | todo   |
| 12  | [Directory & Threading Adapters](todo/TASK_12_directory-threading-adapters.md) | normal     | ~20k   | P1       | 3    | 01, 06     | todo   |

**Parallelizable:** TASK-11 and TASK-12 can run parallel with TASK-09. TASK-10 waits for TASK-09.

---

## Phase 4: Setup UX & Observability (~32k tokens)

| #   | Task                                                     | Complexity | Tokens | Priority | Wave | Depends On | Status |
| --- | -------------------------------------------------------- | ---------- | ------ | -------- | ---- | ---------- | ------ |
| 13  | [CLI Setup Wizard](todo/TASK_13_cli-setup-wizard.md)     | normal     | ~20k   | P1       | 4    | 02, 05, 06 | todo   |
| 14  | [Status & Monitoring](todo/TASK_14_status-monitoring.md) | simple     | ~12k   | P1       | 4    | 03, 06     | todo   |

**Parallelizable:** Both can run simultaneously.

---

## Phase 5: Hardening & Docs (~32k tokens)

| #   | Task                                                   | Complexity | Tokens | Priority | Wave | Depends On | Status |
| --- | ------------------------------------------------------ | ---------- | ------ | -------- | ---- | ---------- | ------ |
| 15  | [Integration Tests](todo/TASK_15_integration-tests.md) | normal     | ~20k   | P1       | 5    | 01-14      | todo   |
| 16  | [Documentation](todo/TASK_16_documentation.md)         | simple     | ~12k   | P2       | 5    | 01-15      | todo   |

**Parallelizable:** Both can run simultaneously (tests don't block docs).

---

## Summary

| Metric                 | Value                            |
| ---------------------- | -------------------------------- |
| Total tasks            | 16                               |
| P0 (must-have)         | 8 (tasks 01-08)                  |
| P1 (should-have)       | 6 (tasks 09-10, 12-15)           |
| P2 (nice-to-have)      | 2 (tasks 11, 16)                 |
| Simple tasks           | 4                                |
| Normal tasks           | 9                                |
| Complex tasks          | 3                                |
| Total estimated tokens | ~260k                            |
| Max single task tokens | ~35k (TASK-06)                   |
| Max parallel agents    | 4 (Wave 1: tasks 01, 02, 04, 05) |

---

## Critical Path

```
TASK-01 → TASK-03 → TASK-06 → TASK-07 → TASK-09 → TASK-10 → TASK-15
                                  └→ TASK-08 ──┘
```

The critical path runs through the client → connection → plugin → inbound/outbound → actions → tools → tests chain. Optimizing execution of TASK-01 and TASK-06 has the highest leverage on total completion time.

---

## Key Files Created

All extension code lives under `extensions/telegram-userbot/`:

```
extensions/telegram-userbot/
├── index.ts                          # Plugin entry point (TASK-06)
├── openclaw.plugin.json              # Plugin manifest (TASK-05)
├── package.json                      # Extension package (TASK-05)
└── src/
    ├── channel.ts                    # ChannelPlugin definition (TASK-06)
    ├── runtime.ts                    # Runtime getter/setter (TASK-06)
    ├── client.ts                     # GramJS client wrapper (TASK-01)
    ├── types.ts                      # TypeScript interfaces (TASK-01)
    ├── errors.ts                     # Error types (TASK-01)
    ├── peer.ts                       # Peer resolution (TASK-01)
    ├── session-store.ts              # Session persistence (TASK-02)
    ├── connection.ts                 # Connection manager (TASK-03)
    ├── flood-control.ts              # Rate limiting (TASK-04)
    ├── config-schema.ts              # Zod config schema (TASK-05)
    ├── inbound.ts                    # MTProto event handler (TASK-07)
    ├── outbound.ts                   # Outbound send logic (TASK-08)
    ├── helpers.ts                    # Message conversion (TASK-07)
    ├── normalize.ts                  # Chat ID normalization (TASK-07)
    ├── monitor.ts                    # Health metrics (TASK-14)
    ├── onboarding.ts                 # CLI setup wizard (TASK-13)
    ├── adapters/
    │   ├── setup.ts                  # Setup adapter (TASK-06)
    │   ├── auth.ts                   # Auth/allowFrom (TASK-06)
    │   ├── config.ts                 # Config adapter (TASK-06)
    │   ├── status.ts                 # Status adapter (TASK-06, TASK-14)
    │   ├── security.ts              # Security policies (TASK-06)
    │   ├── outbound.ts              # Outbound adapter (TASK-08)
    │   ├── message-actions.ts       # Delete/react/forward/pin (TASK-09)
    │   ├── agent-prompt.ts          # Agent capabilities (TASK-10)
    │   ├── streaming.ts             # Typing indicators (TASK-11)
    │   ├── directory.ts             # Contact/dialog resolution (TASK-12)
    │   └── threading.ts             # Forum topic support (TASK-12)
    ├── test-helpers.ts              # Shared test mocks (TASK-15)
    ├── integration.test.ts          # Integration tests (TASK-15)
    ├── live.test.ts                 # Live tests (TASK-15)
    └── *.test.ts                    # Unit tests (per task)
```
