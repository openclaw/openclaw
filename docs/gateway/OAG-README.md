# OAG Runtime — Operational Assurance Gateway

> **Branch:** `codex/argus-private-recovery`
> **Status:** Functional, under validation

---

## What is OAG? / OAG 是什么？

**OAG (Operational Assurance Gateway)** is the runtime observability and recovery layer built around the OpenClaw Gateway and agent loop. It watches three dimensions of system health — channel delivery pressure, stalled sessions, and stuck task follow-ups — then surfaces that state to operators via CLI and injects targeted recovery notes into user sessions.

**OAG（运维保障网关）** 是构建在 OpenClaw Gateway 和 Agent 循环之上的运行时可观测性与恢复层。它监控系统健康的三个维度——频道投递压力、会话停滞、任务跟进卡死——然后通过 CLI 向运维人员呈现状态，并向用户会话注入定向恢复通知。

---

## Problem Statement / 解决的问题

Before OAG, operational state was buried in logs and sentinel state files. Operators had no unified CLI surface to understand what the system was doing during degraded conditions, and users received no notification when the system performed recovery actions on their behalf.

在 OAG 之前，运行状态散落在日志和 sentinel 状态文件中。运维人员没有统一的 CLI 界面来了解系统在降级状态下的行为，用户也不会在系统代为执行恢复操作时收到任何通知。

**Specific gaps addressed / 具体解决的缺口：**

| Gap                                                | Impact                                                  |
| -------------------------------------------------- | ------------------------------------------------------- |
| No operator visibility into delivery backlog       | Operators had to grep logs to detect congestion         |
| No visibility into stalled sessions or stuck tasks | Watchdog activity was invisible outside log files       |
| No user notification for recovery actions          | Users saw unexplained delays without context            |
| Recovery replay was implicit or manual             | Queued messages could be lost after channel flaps       |
| Language mismatch in system notes                  | Recovery notes ignored the user's conversation language |
| Health monitor blind spots                         | Telegram/webhook channels had no staleness detection    |
| 运维人员无法看到投递积压                           | 必须手动搜索日志才能发现拥塞                            |
| 会话停滞和任务卡死不可见                           | 看门狗活动在日志之外完全不可见                          |
| 恢复操作无用户通知                                 | 用户遇到无法解释的延迟却没有上下文                      |
| 恢复重放隐式或手动                                 | 频道闪断后排队消息可能丢失                              |
| 系统通知语言不匹配                                 | 恢复通知忽略了用户的会话语言                            |
| 健康监控盲区                                       | Telegram/webhook 频道没有过期检测                       |

---

## Features / 功能特性

### 1. Operator-Facing Status Surfaces / 运维状态展示

OAG summaries are wired into three CLI commands:

OAG 摘要已集成到三个 CLI 命令中：

- **`openclaw status`** — shows `OAG channels`, `OAG sessions`, `OAG tasks` in the overview
- **`openclaw health`** — includes OAG summaries when the Gateway is healthy enough to answer probes
- **`openclaw doctor`** — includes the same OAG summaries in diagnostic output

Each line provides a concise state label plus key metrics:

每行提供简洁的状态标签和关键指标：

```
OAG channels:  congested · 12 pending · 3 failures · OAG containing pressure on telegram
OAG sessions:  watching 2 sessions · stalled:1, blocked:1 · telegram
OAG tasks:     task follow-up · step 3/5 · 8m · escalation x2
```

**Source:** `src/commands/oag-channel-health.ts`

### 2. Channel Recovery with Delivery Replay / 频道恢复与投递重放

When a channel becomes operational again (reconnect or health transition), OAG automatically replays queued outbound deliveries scoped to that specific channel and account. This prevents message loss after channel flaps.

当频道恢复可用（重连或健康状态转换）时，OAG 会自动重放该特定频道和账户的排队出站投递，防止频道闪断后消息丢失。

**Key behaviors / 关键行为：**

- Recovery is scoped: only deliveries for the recovered channel:account are replayed / 恢复是限定作用域的：只重放已恢复频道:账户的投递
- Concurrent recovery is deduplicated per channel:account / 并发恢复按频道:账户去重
- Rapid reconnect triggers a follow-up recovery pass to catch deliveries queued during the first run / 快速重连会触发跟进恢复，捕获首次运行期间排队的投递
- Delivery queue uses atomic rename for crash safety / 投递队列使用原子重命名保证崩溃安全

**Source:** `src/gateway/server.impl.ts`, `src/infra/outbound/delivery-queue.ts`

### 3. One-Shot Session Recovery Notes / 一次性会话恢复通知

When OAG performs a user-visible recovery action, it injects a one-shot `OAG:` system note into the next matching session reply. Notes are consumed exactly once via a file-based lock with PID-based stale lock recovery.

当 OAG 执行用户可见的恢复操作时，会向匹配的下次会话回复中注入一次性 `OAG:` 系统通知。通知通过基于文件的锁和 PID 过期检测实现精确的一次性消费。

**Example notes / 示例通知：**

```
OAG: I restarted the message gateway to clear lingering channel backlog.
OAG: Channel backlog cleared and delivery resumed.
OAG: I paused extra follow-ups until the affected channel recovers.
```

**Key behaviors / 关键行为：**

- Notes are targeted to specific sessions via `sessionKeys` / 通知通过 `sessionKeys` 定向到特定会话
- All matching notes are delivered (not just the latest) / 所有匹配的通知都会投递（不只是最新的）
- Consumed notes are moved to `delivered_user_notes` for audit / 已消费的通知移到 `delivered_user_notes` 供审计
- File lock includes PID-based stale detection to recover from process crashes / 文件锁包含基于 PID 的过期检测，可从进程崩溃中恢复

**Source:** `src/infra/oag-system-events.ts`

### 4. Session Language-Aware Localization / 会话语言感知本地化

OAG notes and heartbeat prompts are localized based on the session's recent reply language. Language detection scans the session transcript for the most recent user message and applies a conservative heuristic.

OAG 通知和心跳提示根据会话最近的回复语言进行本地化。语言检测扫描会话转录中最近的用户消息，应用保守的启发式算法。

**Supported languages / 支持的语言：**

- `zh-Hans` — Simplified Chinese (detected when ≥2 Han characters and Han count ≥ Latin count / 2) / 简体中文（当汉字 ≥2 且汉字数 ≥ 拉丁字数/2 时检测）
- `en` — English (detected when ≥6 Latin characters and 0 Han characters) / 英文（当拉丁字符 ≥6 且汉字为 0 时检测）
- When detection fails, defaults to English translations / 检测失败时默认使用英文翻译

**Source:** `src/infra/session-language.ts`

### 5. Channel Health Policy / 频道健康策略

The health monitor evaluates channel status on a configurable interval and restarts unhealthy channels automatically.

健康监控器按可配置的间隔评估频道状态，自动重启不健康的频道。

**Evaluation reasons / 评估原因：**

| Reason                  | Meaning                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `healthy`               | Channel is operating normally / 频道正常运行                                                                     |
| `busy`                  | Channel has active runs / 频道有活跃运行                                                                         |
| `disconnected`          | WebSocket reports disconnected / WebSocket 报告断开                                                              |
| `stale-socket`          | WebSocket connected but no events received within threshold / WebSocket 已连接但在阈值内未收到事件               |
| `stale-poll`            | Polling/webhook channel has not received inbound data within threshold / 轮询/webhook 频道在阈值内未收到入站数据 |
| `stuck`                 | Channel is busy but run activity is stale / 频道忙碌但运行活动已过期                                             |
| `startup-connect-grace` | Channel just started, within grace period / 频道刚启动，在宽限期内                                               |

**Key thresholds / 关键阈值：**

- Stale socket threshold: 30 minutes / 过期 socket 阈值：30 分钟
- Stale poll threshold: 60 minutes (2x socket threshold) / 过期轮询阈值：60 分钟（socket 阈值的 2 倍）
- Startup connect grace: 2 minutes / 启动连接宽限：2 分钟
- Max restarts per hour: 10 / 每小时最大重启次数：10

**Source:** `src/gateway/channel-health-policy.ts`, `src/gateway/channel-health-monitor.ts`

### 6. Channel Lifecycle Management / 频道生命周期管理

The channel manager handles start, stop, crash-loop backoff, and recovery hook dispatch for all channel accounts.

频道管理器处理所有频道账户的启动、停止、崩溃循环退避和恢复钩子分发。

**Key behaviors / 关键行为：**

- Auto-restart with exponential backoff (5s → 5min, factor 2, jitter 0.1) / 指数退避自动重启（5 秒 → 5 分钟，因子 2，抖动 0.1）
- Max 10 restart attempts before giving up / 放弃前最多 10 次重启尝试
- Manual stop prevents auto-restart / 手动停止阻止自动重启
- `running=false` and `restartPending` are set atomically to prevent observer TOCTOU / `running=false` 和 `restartPending` 原子设置，防止观察者 TOCTOU
- Recovery hook fires on reconnect or operational transition / 恢复钩子在重连或可用状态转换时触发

**Source:** `src/gateway/server-channels.ts`

---

## Architecture / 架构

```
┌─────────────────────────────────────────────────────┐
│                   Sentinel Pipeline                  │
│  (produces ~/.openclaw/sentinel/channel-health-      │
│   state.json with backlog, session, task watch)      │
└──────────────────────┬──────────────────────────────┘
                       │ reads
                       ▼
┌─────────────────────────────────────────────────────┐
│                    OAG Runtime                        │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ CLI Surfaces  │  │ System Notes │  │  Recovery   │ │
│  │ status/health │  │ one-shot     │  │  replay     │ │
│  │ /doctor       │  │ per-session  │  │  per-channel│ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Health Policy │  │  Language    │  │  Channel   │ │
│  │ stale-socket  │  │  Detection  │  │  Lifecycle │ │
│  │ stale-poll    │  │  zh-Hans/en │  │  Manager   │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────┘
```

---

## State File / 状态文件

All OAG runtime state is read from:

所有 OAG 运行时状态从以下文件读取：

```
~/.openclaw/sentinel/channel-health-state.json
```

This file is produced by the sentinel/watch pipeline and consumed by OAG. It uses snake_case field names (e.g., `affected_channels`, `pending_user_notes`, `session_watch`).

该文件由 sentinel/watch 流水线生成，由 OAG 消费。使用蛇形命名（如 `affected_channels`、`pending_user_notes`、`session_watch`）。

---

## Key Files / 关键文件

| File                                      | Purpose                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `src/commands/oag-channel-health.ts`      | State parsing, summary formatting / 状态解析、摘要格式化              |
| `src/infra/oag-system-events.ts`          | One-shot note consumption with file lock / 一次性通知消费（含文件锁） |
| `src/infra/session-language.ts`           | Session reply language detection / 会话回复语言检测                   |
| `src/infra/heartbeat-runner.ts`           | Heartbeat with language-aware prompts / 语言感知心跳                  |
| `src/gateway/server-channels.ts`          | Channel lifecycle and recovery hooks / 频道生命周期和恢复钩子         |
| `src/gateway/server.impl.ts`              | Gateway wiring and delivery recovery / Gateway 编排和投递恢复         |
| `src/gateway/channel-health-policy.ts`    | Health evaluation (socket + poll) / 健康评估（socket + 轮询）         |
| `src/gateway/channel-health-monitor.ts`   | Background health check loop / 后台健康检查循环                       |
| `src/auto-reply/reply/session-updates.ts` | System event drain into replies / 系统事件排空到回复                  |
| `src/infra/outbound/delivery-queue.ts`    | Crash-safe delivery queue / 崩溃安全投递队列                          |

---

## Troubleshooting / 故障排查

1. Run `openclaw status` for a quick local readout / 运行 `openclaw status` 快速查看本地状态
2. If OAG lines are not `clear`, run `openclaw health --json` to inspect the live Gateway snapshot / 如果 OAG 行不是 `clear`，运行 `openclaw health --json` 查看实时 Gateway 快照
3. Open `~/.openclaw/sentinel/channel-health-state.json` and confirm the tracked entries match the failing path / 打开状态文件确认跟踪条目与故障路径匹配
4. If `OAG channels` reports prolonged backlog after recovery, restart the Gateway / 如果 `OAG channels` 报告恢复后积压持续，重启 Gateway
5. If `OAG sessions` stays blocked by runtime/model errors, inspect the affected session transcript / 如果 `OAG sessions` 持续被运行时/模型错误阻塞，检查受影响的会话转录

---

## Recent Fixes (Code Review) / 近期修复（代码审查）

The following issues were identified during code review and fixed in this branch:

以下问题在代码审查中发现并在此分支修复：

| #   | Fix                                                                                                                                                                     | Severity    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | `readOptionalString` returning `undefined` caused `.length` crash in session key parsing / `readOptionalString` 返回 `undefined` 导致 session key 解析崩溃              | High / 高   |
| 2   | Multiple consumed notes were silently discarded — only the latest was shown / 多条消费的通知被静默丢弃，只展示最新的                                                    | Medium / 中 |
| 3   | Stale file lock after process crash permanently blocked note delivery / 进程崩溃后的过期文件锁永久阻塞通知投递                                                          | Medium / 中 |
| 4   | Rapid channel disconnect/reconnect skipped recovery replay / 频道快速断开/重连跳过恢复重放                                                                              | Medium / 中 |
| 5   | `undefined` language fell back to raw producer message instead of English / `undefined` 语言回退到原始生产者消息而非英文                                                | Low / 低    |
| 6   | TOCTOU between `running=false` and `restartPending=true` in channel restart / 频道重启中 `running=false` 和 `restartPending=true` 之间的 TOCTOU                         | Low / 低    |
| 7   | Telegram/webhook channels had no staleness detection — added `stale-poll` via `lastInboundAt` / Telegram/webhook 频道无过期检测——通过 `lastInboundAt` 新增 `stale-poll` | Low / 低    |

---

## Development / 开发

```bash
# Install dependencies / 安装依赖
pnpm install

# Type check / 类型检查
pnpm tsgo

# Run tests / 运行测试
pnpm test

# Run OAG-related tests / 运行 OAG 相关测试
pnpm test -- --run src/gateway/server-channels.test.ts src/gateway/channel-health-policy.test.ts
```

---

## License

See the root [LICENSE](../../LICENSE) file.
