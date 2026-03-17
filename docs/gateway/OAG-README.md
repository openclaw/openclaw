# OAG Runtime — Operational Assurance Gateway

> **Branch:** `codex/argus-private-recovery`
> **Status:** Phase 2 complete, 331 tests passing
> **Stats:** 28 commits, 70+ files, ~14,400 lines added

---

## What is OAG? / OAG 是什么？

**OAG (Operational Assurance Gateway)** is the self-evolving runtime observability and recovery layer for the OpenClaw Gateway. It monitors channel delivery pressure, stalled sessions, and stuck task follow-ups, then automatically recovers, adapts its own parameters based on crash history, and notifies users — all without human intervention.

**OAG（运维保障网关）** 是 OpenClaw Gateway 的自进化运行时可观测性与恢复层。它监控频道投递压力、会话停滞和任务跟进卡死，然后自动恢复、根据崩溃历史自适应调整参数并通知用户——全程无需人工干预。

---

## Architecture / 架构全景

```
                           ┌─────────────────────┐
                           │   Admin WebSocket    │ ← Real-time OAG event push
                           │   (oag events)       │
                           └──────────┬──────────┘
                                      │
┌─────────────────────────────────────────────────────────────┐
│                     OAG Runtime Layer                        │
│                                                             │
│  ┌──────────────────┐   ┌──────────────────┐                │
│  │ Channel Profiles │   │ Config Cascade   │                │
│  │ websocket/polling│   │ channel > global │                │
│  │ webhook/local    │   │ > transport dflt │                │
│  │ 20+ channels     │   │ > hardcoded dflt │                │
│  └──────────────────┘   └──────────────────┘                │
│                                                             │
│  ┌──────────────────┐   ┌──────────────────┐                │
│  │ Health Policy    │   │ Metrics + Trends │                │
│  │ transport-aware  │   │ hourly snapshots  │                │
│  │ stale detection  │   │ 6h trend analysis │                │
│  └──────────────────┘   │ persist restarts  │                │
│                         └──────────────────┘                │
│  ┌──────────────────┐   ┌──────────────────┐                │
│  │ Evolution Engine │   │ Feedback Loop    │                │
│  │ 6h periodic      │   │ track outcomes   │                │
│  │ channel-scoped   │   │ enrich prompts   │                │
│  │ sentinel context │   │ learn from past  │                │
│  └──────────────────┘   └──────────────────┘                │
│                                                             │
│  ┌──────────────────┐   ┌──────────────────┐                │
│  │ CLI Visibility   │   │ Event Bus        │                │
│  │ status + oag cmd │   │ → WS broadcast   │                │
│  │ audit log        │   │ → admin scope    │                │
│  └──────────────────┘   └──────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

---

## Channel Transport Profiles / 频道传输层配置

OAG automatically detects each channel's transport type and applies optimized defaults — zero configuration required.

OAG 自动检测每个频道的传输类型并应用优化默认值——无需配置。

### Transport Types / 传输类型

| Transport     | Channels                                            | Stale Threshold     | Recovery Budget       | Max Retries          | Health Detection        |
| ------------- | --------------------------------------------------- | ------------------- | --------------------- | -------------------- | ----------------------- |
| **websocket** | Discord, Slack, WhatsApp, Mattermost, IRC, Feishu   | 30 min              | 30s (fast reconnect)  | 5                    | `stale-socket`          |
| **polling**   | Telegram, Matrix, Zalo, Nextcloud Talk, Tlon, Nostr | 60 min (30 min × 2) | 90s (slower recovery) | 8 (more durable)     | `stale-poll`            |
| **webhook**   | LINE, Google Chat, MS Teams, Synology Chat          | N/A (passive)       | 60s                   | 5                    | None (passive receiver) |
| **local**     | iMessage, BlueBubbles, Signal                       | 60 min              | 15s (fast restart)    | 3 (daemon-dependent) | `stale-poll`            |

### Config Cascade / 配置级联

Three-tier resolution, most specific wins:

```
1. Channel override:    gateway.oag.channels.telegram.delivery.maxRetries: 10
2. Global config:       gateway.oag.delivery.maxRetries: 6
3. Transport default:   polling → 8
4. Hardcoded fallback:  5
```

Extensions register their transport type at runtime:

```typescript
import { registerChannelTransport } from "./infra/oag-channel-profiles.js";
registerChannelTransport("my-custom-channel", "websocket");
```

---

## Features / 功能特性

### 1. Operator-Facing Status / 运维状态展示

OAG summaries integrated into CLI commands:

```
$ openclaw status
OAG:            3 restarts · 12 recoveries · 0 failures · 2 incidents
OAG evolution:  last 2h ago · effective · recoveryBudgetMs 60000→90000

$ openclaw oag history
$ openclaw oag status
$ openclaw oag incidents
```

- **`openclaw status`** — OAG metrics + evolution summary inline
- **`openclaw oag status`** — Full OAG runtime metrics (all 9 counters)
- **`openclaw oag history`** — Lifecycle, evolution, and diagnosis history
- **`openclaw oag incidents`** — Active incidents from current session
- **`openclaw health --json`** — Live snapshot with `oagMetrics` field
- **`openclaw doctor`** — Diagnostic output with OAG summaries

### 2. Channel Recovery with Delivery Replay / 频道恢复与投递重放

When a channel reconnects, OAG automatically replays queued outbound deliveries:

- Scoped to recovered channel:account only / 仅限已恢复的频道:账户
- Concurrent recovery deduplicated / 并发恢复去重
- Rapid reconnect triggers follow-up recovery pass / 快速重连触发跟进恢复
- Crash-safe delivery queue with atomic rename / 崩溃安全投递队列
- Async JSON index for fast filtered lookups / 异步 JSON 索引

### 3. One-Shot Recovery Notes / 一次性恢复通知

```
OAG: I restarted the message gateway to clear lingering channel backlog.
OAG: I analyzed 4 recent incidents and adjusted the recovery budget to reduce channel disruption.
```

- Targeted to specific sessions via `sessionKeys`
- Consumed exactly once with atomic file lock
- Deduplicated by action within 60s window (configurable)
- Localized to zh-Hans / en / ja / ko

### 4. Channel Health Policy / 频道健康策略

Transport-aware health evaluation:

| Reason         | Applies to      | Meaning                              |
| -------------- | --------------- | ------------------------------------ |
| `healthy`      | All             | Operating normally                   |
| `busy`         | All             | Active runs in progress              |
| `disconnected` | WebSocket       | Connection lost                      |
| `stale-socket` | WebSocket       | No events within threshold (30 min)  |
| `stale-poll`   | Polling / Local | No inbound within threshold (60 min) |
| `stuck`        | All             | Busy but no activity for 25+ min     |

Auto-restart with exponential backoff (5s → 5min), max 10 attempts per channel.

### 5. Structured Metrics / 结构化指标

9 counters exposed via `/health` endpoint, persisted across restarts with hourly snapshots:

| Counter                    | Description                       |
| -------------------------- | --------------------------------- |
| `channelRestarts`          | Health monitor triggered restarts |
| `deliveryRecoveries`       | Successful delivery recoveries    |
| `deliveryRecoveryFailures` | Failed delivery recoveries        |
| `staleSocketDetections`    | WebSocket stale detections        |
| `stalePollDetections`      | Polling stale detections          |
| `noteDeliveries`           | OAG notes delivered               |
| `noteDeduplications`       | Duplicate notes suppressed        |
| `lockAcquisitions`         | Lock acquisitions                 |
| `lockStalRecoveries`       | Stale lock recoveries             |

### 6. Configurable Parameters / 可配置参数

All OAG constants are tunable via `gateway.oag.*` config. Changes take effect at runtime without restart.

**Delivery & Health:**

| Parameter                   | Default | Description                 |
| --------------------------- | ------- | --------------------------- |
| `delivery.maxRetries`       | 5       | Max delivery retry attempts |
| `delivery.recoveryBudgetMs` | 60000   | Recovery time budget (ms)   |
| `lock.timeoutMs`            | 2000    | Lock acquire timeout (ms)   |
| `lock.staleMs`              | 30000   | Stale lock threshold (ms)   |
| `health.stalePollFactor`    | 2       | Poll stale multiplier       |
| `notes.dedupWindowMs`       | 60000   | Note dedup window (ms)      |
| `notes.maxDeliveredHistory` | 20      | Audit trail cap             |

**Evolution (all configurable):**

| Parameter                              | Default  | Description                    |
| -------------------------------------- | -------- | ------------------------------ |
| `evolution.maxStepPercent`             | 50       | Max single adjustment (%)      |
| `evolution.maxCumulativePercent`       | 200      | Max total drift (%)            |
| `evolution.cooldownMs`                 | 14400000 | Between evolutions (4h)        |
| `evolution.observationWindowMs`        | 3600000  | Regression check period (1h)   |
| `evolution.restartRegressionThreshold` | 5        | Restarts triggering rollback   |
| `evolution.failureRegressionThreshold` | 3        | Failures triggering rollback   |
| `evolution.minCrashesForAnalysis`      | 2        | Min crashes before analysis    |
| `evolution.maxNotificationsPerDay`     | 3        | Evolution notification limit   |
| `evolution.periodicAnalysisIntervalMs` | 21600000 | Runtime analysis interval (6h) |

**Per-channel overrides:** `gateway.oag.channels.<channelId>.delivery.*`

---

## Self-Evolution System / 自进化系统

OAG continuously learns from operational patterns and automatically improves its own parameters.

### Evolution Flow / 进化流程

```
Runtime Operation (continuous)
    │
    ├── Incident collector records events (crash loops, delivery failures, stale detections)
    ├── Hourly metrics snapshots persisted to oag-memory.json
    │
    ├── Every 6 hours: periodic analysis (or on restart)
    │   ├── Load crash history + sentinel crash context (session, channel)
    │   ├── Wait for idle window (don't disrupt user messages)
    │   ├── Analyze incident patterns with 6h trend comparison
    │   ├── 80%+ incidents from one channel? → channel-scoped recommendation
    │   ├── Generate recommendations with safety clamping
    │   │
    │   ├── Low-risk → auto-apply to config (channel-scoped or global)
    │   ├── Start 1-hour rollback observation window
    │   │   ├── Regression (5 restarts or 3 failures) → auto-revert
    │   │   └── No regression → mark "effective"
    │   │
    │   ├── Track recommendation outcome (effective / reverted / neutral)
    │   ├── Feed outcome history into next diagnosis prompt (feedback loop)
    │   │
    │   ├── Emit WebSocket event to admin UI
    │   └── Inject OAG notification to affected user sessions
    │
    └── User perceives: system gets more stable over time
```

### Safety Rails / 安全护栏

| Rail                    | Value                    | Description                               |
| ----------------------- | ------------------------ | ----------------------------------------- |
| Max step                | 50%                      | Single adjustment capped at 50% change    |
| Max cumulative          | 200%                     | Total drift from original value           |
| Cooldown                | 4 hours                  | Minimum gap between evolutions            |
| Observation window      | 1 hour                   | Regression check period after apply       |
| Rollback trigger        | 5 restarts or 3 failures | Auto-revert threshold                     |
| Notification limit      | 3 per 24h                | Avoid notification flood                  |
| Observation persistence | Survives restarts        | Stored in oag-memory.json                 |
| Concurrent protection   | Module-level flag        | Prevents parallel postmortem runs         |
| Prompt sanitization     | 200 char limit           | Prevents prompt injection in AI diagnosis |

### Agent-Assisted Diagnosis / Agent 辅助诊断

When heuristic analysis is insufficient, OAG escalates to AI agent diagnosis:

- Structured prompt from crash history + metrics + config + trend data
- Historical recommendation outcomes included (feedback loop)
- JSON response parsing with confidence scoring
- Low-risk recommendations auto-applied, medium/high require approval
- 60-second timeout prevents agent hangs
- 4-hour cooldown per trigger type

### WebSocket Real-Time Events / WebSocket 实时事件

OAG events are broadcast to admin WebSocket clients (requires `operator.admin` scope):

| Event                 | When                                 |
| --------------------- | ------------------------------------ |
| `incident_recorded`   | New incident detected                |
| `evolution_applied`   | Config change applied                |
| `evolution_reverted`  | Regression detected, config reverted |
| `evolution_confirmed` | Observation window passed, effective |
| `diagnosis_completed` | Agent diagnosis finished             |
| `metrics_snapshot`    | Hourly metrics persisted             |

---

## Key Files / 关键文件

### Core Runtime / 核心运行时

| File                                    | Purpose                                          |
| --------------------------------------- | ------------------------------------------------ |
| `src/infra/oag-channel-profiles.ts`     | Channel transport registry (20+ channels)        |
| `src/commands/oag-channel-health.ts`    | State parsing + formatting + schema versioning   |
| `src/commands/oag.command.ts`           | `openclaw oag` CLI commands                      |
| `src/infra/oag-system-events.ts`        | Note consumption with atomic lock + dedup        |
| `src/infra/session-language.ts`         | Language detection (zh/en/ja/ko, 100-line limit) |
| `src/gateway/server-channels.ts`        | Channel lifecycle + recovery hooks               |
| `src/gateway/server.impl.ts`            | Gateway orchestration + OAG lifecycle wiring     |
| `src/gateway/channel-health-policy.ts`  | Transport-aware health evaluation                |
| `src/gateway/channel-health-monitor.ts` | Background health loop + transport profiles      |

### Infrastructure / 基础设施

| File                                   | Purpose                                       |
| -------------------------------------- | --------------------------------------------- |
| `src/infra/oag-metrics.ts`             | 9 counters + snapshot/restore across restarts |
| `src/infra/oag-config.ts`              | 18 resolvers with 3-tier channel cascade      |
| `src/config/types.oag.ts`              | OAG config types (with per-channel support)   |
| `src/infra/oag-config-writer.ts`       | Atomic config write-back (channel-scoped)     |
| `src/infra/outbound/delivery-queue.ts` | Crash-safe delivery queue                     |
| `src/infra/outbound/delivery-index.ts` | Async JSON index for fast lookups             |
| `src/infra/oag-event-bus.ts`           | Event bus + fs.watch + WS broadcast bridge    |

### Self-Evolution / 自进化

| File                                  | Purpose                                        |
| ------------------------------------- | ---------------------------------------------- |
| `src/infra/oag-memory.ts`             | Persistent memory + metrics series + audit log |
| `src/infra/oag-incident-collector.ts` | Runtime incident aggregation + event emission  |
| `src/infra/oag-postmortem.ts`         | Periodic analysis + channel-scoped evolution   |
| `src/infra/oag-evolution-guard.ts`    | Rollback guard + recommendation tracking       |
| `src/infra/oag-evolution-notify.ts`   | Evolution notification with file locking       |
| `src/infra/oag-diagnosis.ts`          | AI diagnosis prompts with feedback history     |
| `src/infra/oag-diagnosis-dispatch.ts` | Diagnosis dispatch with 60s timeout            |
| `src/infra/oag-scheduler.ts`          | Idle-window task scheduler                     |

---

## Test Coverage / 测试覆盖

| Test File                           | Tests   |
| ----------------------------------- | ------- |
| `oag-channel-health.test.ts`        | 27      |
| `channel-health-policy.test.ts`     | 32      |
| `oag-channel-profiles.test.ts`      | 18      |
| `oag-postmortem.test.ts`            | 18      |
| `oag-memory.test.ts`                | 17      |
| `oag-config.test.ts`                | 25      |
| `oag-diagnosis.test.ts`             | 16      |
| `oag-system-events.test.ts`         | 16      |
| `status.test.ts`                    | 15      |
| `gateway-status.test.ts`            | 12      |
| `oag-event-bus.test.ts`             | 12      |
| `server-oag-integration.test.ts`    | 12      |
| `oag-metrics.test.ts`               | 11      |
| `oag-filesystem.test.ts`            | 11      |
| `oag-config-writer.test.ts`         | 9       |
| `oag-evolution-guard.test.ts`       | 9       |
| `session-language.test.ts`          | 8       |
| `oag-e2e.test.ts`                   | 7       |
| `oag-concurrency.test.ts`           | 7       |
| `oag-evolution-notify.test.ts`      | 6       |
| `oag-incident-collector.test.ts`    | 6       |
| `oag-scheduler.test.ts`             | 6       |
| `session-language-infer.test.ts`    | 5       |
| `server-channels.test.ts`           | 5       |
| `delivery-index.test.ts`            | 5       |
| `oag-diagnosis-dispatch.test.ts`    | 3       |
| `oag-evolution.integration.test.ts` | 3       |
| `outbound.test.ts`                  | 66      |
| `delivery-benchmark.test.ts`        | 2       |
| **Total**                           | **331** |

---

## Troubleshooting / 故障排查

```bash
# Quick status check
openclaw status

# Full OAG metrics
openclaw oag status

# Lifecycle + evolution history
openclaw oag history --limit 20

# Active incidents
openclaw oag incidents

# Live health snapshot
openclaw health --json

# Raw state files
cat ~/.openclaw/sentinel/channel-health-state.json
cat ~/.openclaw/sentinel/oag-memory.json | jq .evolutions
cat ~/.openclaw/sentinel/oag-memory.json | jq .auditLog
cat ~/.openclaw/sentinel/oag-memory.json | jq .metricSeries[-1]

# Manual config override (per-channel or global)
openclaw config set gateway.oag.channels.telegram.delivery.maxRetries 10
openclaw config set gateway.oag.delivery.recoveryBudgetMs 120000
```

---

## Development / 开发

```bash
pnpm install                  # Install dependencies
pnpm tsgo                     # Type check
pnpm test                     # Run all tests

# Run OAG tests only (331 tests)
pnpm test -- --run \
  src/infra/oag-*.test.ts \
  src/infra/session-language*.test.ts \
  src/infra/outbound/delivery-*.test.ts \
  src/commands/oag-*.test.ts \
  src/commands/status.test.ts \
  src/commands/gateway-status.test.ts \
  src/gateway/channel-health-policy.test.ts \
  src/gateway/server-channels.test.ts \
  src/gateway/server-oag-integration.test.ts
```

---

## License

See the root [LICENSE](../../LICENSE) file.
