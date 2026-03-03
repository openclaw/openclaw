# TASK_14: Status & Monitoring

<!-- SUMMARY: Provides real-time health metrics and status reporting for the userbot channel in CLI and dashboards -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | simple              |
| **Est. Tokens** | ~12k                |
| **Priority**    | P1                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 4                   |
| **Wave**        | 4                   |

---

## SDD References

| Document  | Path                                                               | Sections                    |
| --------- | ------------------------------------------------------------------ | --------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §3 SC-9 (Graceful fallback) |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §3.5 Status Adapter         |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-14                     |

## Task Dependency Tree

```
TASK-03 (Connection) ───┐
TASK-06 (Plugin) ───────┤
                        ▼
           TASK-14 (Status & Monitoring) ←── you are here
```

## Description

Enhance the status adapter and create a monitor module for comprehensive health reporting:

1. **CLI status output:** `openclaw status` shows connection state, username, uptime, DC ID
2. **Probe support:** `openclaw channels status --probe` tests connection health in real-time
3. **Metric counters:** messages_sent, messages_received, errors, flood_waits, reconnects
4. **Event logging:** Log flood_wait events with duration, reconnection events with attempt count
5. **Cross-channel alerting:** If userbot disconnected for >5 min, alert via another channel (e.g., bot)

**Business value:** Operators can monitor the userbot health, catch issues early, and ensure reliable operation (supports SC-9 graceful fallback).

---

## Context

### Related Files (from codebase research)

| File                                                | Purpose                          | Patterns to Follow                                                                                         |
| --------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/channels/plugins/types.adapters.ts` (line 125) | `ChannelStatusAdapter` interface | defaultRuntime, buildChannelSummary, probeAccount, auditAccount, buildAccountSnapshot, collectStatusIssues |
| `src/plugin-sdk/index.ts`                           | Status helpers                   | `buildBaseAccountStatusSnapshot`, `buildBaseChannelStatusSummary`, `buildTokenChannelStatusSummary`        |
| `extensions/discord/src/channel.ts`                 | Discord status                   | Status adapter implementation example                                                                      |
| `extensions/irc/src/channel.ts`                     | IRC status/probe                 | Probe pattern for TCP connections                                                                          |

### Code Dependencies

- `ConnectionManager` from TASK-03 — health() metrics
- Plugin runtime — status reporting infrastructure
- `openclaw/plugin-sdk` — `buildBaseAccountStatusSnapshot`, `buildBaseChannelStatusSummary`

---

## Goals

1. Rich CLI status output with connection details
2. Probe functionality for real-time health check
3. Metric counters for observability
4. Cross-channel disconnect alerting

---

## Acceptance Criteria

**AC-1: CLI status display**

- Given: Userbot is connected
- When: `openclaw status` is run
- Then: Shows `telegram-userbot: ✓ connected (@amazing_nero, uptime 2h, DC5)`

**AC-2: CLI status — disconnected**

- Given: Userbot is disconnected
- When: `openclaw status` is run
- Then: Shows `telegram-userbot: ✗ disconnected (last seen: 5m ago, 3 reconnect attempts)`

**AC-3: Probe health check**

- Given: User runs `openclaw channels status --probe`
- When: Probe is executed
- Then: Tests connection by calling `getMe()`, reports latency and DC

**AC-4: Metric counters**

- Given: Userbot has been running
- When: Metrics are queried
- Then: Returns `{ messagesSent, messagesReceived, errors, floodWaits, reconnects }`

**AC-5: Flood wait logging**

- Given: Telegram returns FLOOD_WAIT_30
- When: Event is processed
- Then: Logged as `[telegram-userbot] Flood wait: 30s`

**AC-6: Disconnect alert**

- Given: Userbot has been disconnected for >5 minutes and bot channel is available
- When: Alert threshold is reached
- Then: Alert is sent via the bot channel (or logged if no other channel available)

---

## Dependencies

**Depends on:**

- TASK-03 (Connection Manager) — health metrics source
- TASK-06 (Plugin Entry) — status adapter wiring

**Blocks:**

- None (observability enhancement)

---

## Files to Change

| Action | File                                                 | Scope                                          |
| ------ | ---------------------------------------------------- | ---------------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/monitor.ts`         | Health metrics collection and alerting         |
| UPDATE | `extensions/telegram-userbot/src/adapters/status.ts` | Enhance status adapter with probe and snapshot |
| CREATE | `extensions/telegram-userbot/src/monitor.test.ts`    | Unit tests for metrics and alerting            |

---

## Risks & Mitigations

| Risk                                    | Likelihood | Impact | Mitigation                                |
| --------------------------------------- | ---------- | ------ | ----------------------------------------- |
| Probe call adds latency to status check | Low        | Low    | Probe is opt-in (--probe flag)            |
| Alert spam if connection is flapping    | Medium     | Low    | Debounce alerts, min 5 min between alerts |
| Metrics memory growth                   | Low        | Low    | Use simple counters, not time series      |

---

## Out of Scope

- Grafana/Prometheus metrics export
- Historical metrics storage
- Web dashboard for status
- Alerting via email/SMS

---

## Testing

| Type | Description                       | File                                              |
| ---- | --------------------------------- | ------------------------------------------------- |
| Unit | Status display formatting         | `extensions/telegram-userbot/src/monitor.test.ts` |
| Unit | Probe returns correct health info | `extensions/telegram-userbot/src/monitor.test.ts` |
| Unit | Metric counter accuracy           | `extensions/telegram-userbot/src/monitor.test.ts` |
| Unit | Alert debouncing                  | `extensions/telegram-userbot/src/monitor.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                              |
| -------------- | ------ | ---------------------------------- |
| Research       | ~3k    | Study status adapter patterns      |
| Implementation | ~6k    | Monitor module, status enhancement |
| Testing        | ~3k    | Unit tests                         |
| **Total**      | ~12k   | Focused monitoring task            |

---

## Subtasks

- [ ] 1.  Create `monitor.ts` with metric counters (sent, received, errors, flood waits, reconnects)
- [ ] 2.  Enhance status adapter with rich CLI status formatting
- [ ] 3.  Implement probe functionality (getMe + latency measurement)
- [ ] 4.  Implement account snapshot builder
- [ ] 5.  Add flood wait event logging
- [ ] 6.  Implement disconnect alert with 5-min debounce
- [ ] 7.  Write unit tests for metrics, probe, and alerting
