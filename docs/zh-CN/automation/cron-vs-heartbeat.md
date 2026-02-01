---
read_when:
  - 决定如何调度周期性任务
  - 设置后台监控或通知
  - 优化定期检查的 token 用量
summary: 选择心跳还是定时任务进行自动化的指南
title: 定时任务与心跳对比
x-i18n:
  generated_at: "2026-02-01T19:38:18Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 5f71a63181baa41b1c307eb7bfac561df7943d4627077dfa2861eb9f76ab086b
  source_path: automation/cron-vs-heartbeat.md
  workflow: 14
---

# 定时任务与心跳：何时使用哪种方式

心跳和定时任务都可以按计划运行任务。本指南帮助你根据使用场景选择合适的机制。

## 快速决策指南

| 使用场景                  | 推荐方式                   | 原因                                     |
| ------------------------- | -------------------------- | ---------------------------------------- |
| 每 30 分钟检查收件箱      | 心跳                       | 可与其他检查批量处理，具备上下文感知能力 |
| 每天上午 9 点准时发送报告 | 定时任务（隔离式）         | 需要精确定时                             |
| 监控日历中即将到来的事件  | 心跳                       | 天然适合周期性感知                       |
| 运行每周深度分析          | 定时任务（隔离式）         | 独立任务，可使用不同模型                 |
| 20 分钟后提醒我           | 定时任务（主会话，`--at`） | 精确定时的一次性任务                     |
| 后台项目健康检查          | 心跳                       | 搭载在现有周期上                         |

## 心跳：周期性感知

心跳在**主会话**中以固定间隔运行（默认：30 分钟）。它的设计目的是让智能体检查各种事项并呈现重要信息。

### 何时使用心跳

- **多个周期性检查**：与其设置 5 个独立的定时任务分别检查收件箱、日历、天气、通知和项目状态，不如用一次心跳批量处理所有内容。
- **上下文感知决策**：智能体拥有完整的主会话上下文，因此可以智能判断哪些紧急、哪些可以等待。
- **对话连续性**：心跳运行共享同一会话，因此智能体记得最近的对话，可以自然地进行后续跟进。
- **低开销监控**：一次心跳替代多个小型轮询任务。

### 心跳优势

- **批量处理多项检查**：一次智能体轮次可以同时审查收件箱、日历和通知。
- **减少 API 调用**：一次心跳比 5 个隔离式定时任务更经济。
- **上下文感知**：智能体了解你一直在做什么，可以据此排定优先级。
- **智能抑制**：如果没有需要关注的事项，智能体回复 `HEARTBEAT_OK`，不会投递任何消息。
- **自然定时**：会根据队列负载略有漂移，但对大多数监控来说没有问题。

### 心跳示例：HEARTBEAT.md 检查清单

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

智能体在每次心跳时读取此清单，并在一次轮次中处理所有项目。

### 配置心跳

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 间隔
        target: "last", // 告警投递目标
        activeHours: { start: "08:00", end: "22:00" }, // 可选
      },
    },
  },
}
```

完整配置请参阅[心跳](/gateway/heartbeat)。

## 定时任务：精确调度

定时任务在**精确时间**运行，可以在隔离会话中运行而不影响主会话上下文。

### 何时使用定时任务

- **需要精确定时**："每周一上午 9:00 发送"（而不是"大约 9 点左右"）。
- **独立任务**：不需要对话上下文的任务。
- **不同的模型/思维级别**：需要更强大模型的深度分析。
- **一次性提醒**：使用 `--at` 实现"20 分钟后提醒我"。
- **嘈杂/频繁的任务**：会把主会话历史搞得杂乱的任务。
- **外部触发器**：无论智能体是否处于活跃状态都应独立运行的任务。

### 定时任务优势

- **精确定时**：支持带时区的 5 字段 cron 表达式。
- **会话隔离**：在 `cron:<jobId>` 中运行，不会污染主会话历史。
- **模型覆盖**：可按任务使用更便宜或更强大的模型。
- **投递控制**：可直接投递到渠道；默认仍会向主会话发布摘要（可配置）。
- **无需智能体上下文**：即使主会话空闲或已压缩，也能运行。
- **一次性支持**：`--at` 用于精确的未来时间戳。

### 定时任务示例：每日早间简报

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --deliver \
  --channel whatsapp \
  --to "+15551234567"
```

这会在纽约时间每天早上 7:00 准时运行，使用 Opus 保证质量，并直接投递到 WhatsApp。

### 定时任务示例：一次性提醒

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

完整 CLI 参考请参阅[定时任务](/automation/cron-jobs)。

## 决策流程图

```
任务是否需要在精确时间运行？
  是 -> 使用定时任务
  否 -> 继续...

任务是否需要与主会话隔离？
  是 -> 使用定时任务（隔离式）
  否 -> 继续...

此任务能否与其他周期性检查批量处理？
  是 -> 使用心跳（添加到 HEARTBEAT.md）
  否 -> 使用定时任务

这是一次性提醒吗？
  是 -> 使用定时任务配合 --at
  否 -> 继续...

是否需要不同的模型或思维级别？
  是 -> 使用定时任务（隔离式）配合 --model/--thinking
  否 -> 使用心跳
```

## 组合使用

最高效的配置是**两者结合**：

1. **心跳**处理常规监控（收件箱、日历、通知），每 30 分钟批量处理一次。
2. **定时任务**处理精确调度（每日报告、每周回顾）和一次性提醒。

### 示例：高效自动化配置

**HEARTBEAT.md**（每 30 分钟检查一次）：

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**定时任务**（精确定时）：

```bash
# 每天早上 7 点的早间简报
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --deliver

# 每周一上午 9 点的项目回顾
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# 一次性提醒
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster：带审批的确定性工作流

Lobster 是用于**多步骤工具管道**的工作流运行时，适用于需要确定性执行和明确审批的场景。当任务不只是单次智能体轮次，且你需要可恢复的带人工检查点的工作流时，使用它。

### 何时适合使用 Lobster

- **多步骤自动化**：你需要一个固定的工具调用管道，而不是一次性提示。
- **审批关卡**：副作用应暂停直到你批准，然后继续执行。
- **可恢复运行**：继续暂停的工作流而无需重新运行之前的步骤。

### 如何与心跳和定时任务配合

- **心跳/定时任务**决定*何时*运行。
- **Lobster** 定义运行开始后*执行哪些步骤*。

对于计划性工作流，使用定时任务或心跳触发一次调用 Lobster 的智能体轮次。对于临时工作流，直接调用 Lobster。

### 操作说明（来自代码）

- Lobster 以**本地子进程**（`lobster` CLI）在工具模式下运行，并返回 **JSON 信封**。
- 如果工具返回 `needs_approval`，你需要使用 `resumeToken` 和 `approve` 标志来恢复。
- 该工具是**可选插件**；建议通过 `tools.alsoAllow: ["lobster"]` 附加启用。
- 如果传入 `lobsterPath`，必须是**绝对路径**。

完整用法和示例请参阅 [Lobster](/tools/lobster)。

## 主会话与隔离会话

心跳和定时任务都可以与主会话交互，但方式不同：

|        | 心跳                     | 定时任务（主会话）     | 定时任务（隔离式） |
| ------ | ------------------------ | ---------------------- | ------------------ |
| 会话   | 主会话                   | 主会话（通过系统事件） | `cron:<jobId>`     |
| 历史   | 共享                     | 共享                   | 每次运行全新       |
| 上下文 | 完整                     | 完整                   | 无（从零开始）     |
| 模型   | 主会话模型               | 主会话模型             | 可覆盖             |
| 输出   | 非 `HEARTBEAT_OK` 时投递 | 心跳提示 + 事件        | 摘要发布到主会话   |

### 何时使用主会话定时任务

当你需要以下场景时，使用 `--session main` 配合 `--system-event`：

- 提醒/事件出现在主会话上下文中
- 智能体在下一次心跳时带着完整上下文处理它
- 不需要单独的隔离运行

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### 何时使用隔离式定时任务

当你需要以下场景时，使用 `--session isolated`：

- 无先前上下文的全新环境
- 不同的模型或思维设置
- 输出直接投递到渠道（摘要默认仍会发布到主会话）
- 不会把主会话搞得杂乱的历史记录

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --deliver
```

## 成本考量

| 机制               | 成本特征                                       |
| ------------------ | ---------------------------------------------- |
| 心跳               | 每 N 分钟一次轮次；随 HEARTBEAT.md 大小扩展    |
| 定时任务（主会话） | 将事件添加到下一次心跳（无隔离轮次）           |
| 定时任务（隔离式） | 每个任务一次完整智能体轮次；可使用更便宜的模型 |

**建议**：

- 保持 `HEARTBEAT.md` 精简以减少 token 开销。
- 将类似的检查批量放入心跳，而不是创建多个定时任务。
- 如果只需要内部处理，在心跳上使用 `target: "none"`。
- 对常规任务使用隔离式定时任务配合更便宜的模型。

## 相关内容

- [心跳](/gateway/heartbeat) - 完整的心跳配置
- [定时任务](/automation/cron-jobs) - 完整的定时任务 CLI 和 API 参考
- [系统](/cli/system) - 系统事件 + 心跳控制
