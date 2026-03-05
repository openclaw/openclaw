# OpenClaw 心跳 (Heartbeat) 与 Cron 机制详解

本文档详细介绍了 OpenClaw 项目中的心跳机制和 Cron 机制，分析它们的区别、设计初衷以及从原理到实践的实现细节。

## 1. 核心概念与设计初衷

在构建自主 AI Agent 时，我们面临两个核心问题：

1.  **主动性 (Proactivity)**: Agent 如何在用户不说话时主动检查状态、提醒用户或处理后台任务？
2.  **确定性调度 (Deterministic Scheduling)**: 如何确保某些任务在特定时间精确执行，而不依赖于 Agent 的“心情”或当前上下文？

OpenClaw 引入了 **Heartbeat** 和 **Cron** 两种机制来分别解决这两个问题。

- **Heartbeat (心跳)**: 模拟 Agent 的“潜意识”或“例行检查”。它是一个周期性的唤醒机制，让 Agent 在主会话上下文中“醒来”，检查是否有需要处理的事项（如 `HEARTBEAT.md` 中的清单），如果没有则继续“睡眠”。它的核心是**上下文感知**和**静默检查**。
- **Cron (定时任务)**: 传统的作业调度器，用于精确控制任务的执行时间。它可以触发独立的任务（不污染主会话上下文），也可以向主会话注入事件。它的核心是**精确调度**和**任务隔离**。

## 2. 心跳机制 (Heartbeat)

### 2.1 原理

心跳机制本质上是一个定时器，它定期触发 Agent 的主会话 (Main Session) 进行一次“思考”。

- **触发源**: `src/infra/heartbeat-runner.ts` 中的定时循环。
- **上下文**: 运行在 Agent 的主会话中，因此 Agent **拥有与用户历史对话的完整上下文**。
- **提示词 (Prompt)**: 系统会注入一段特殊的 Prompt（默认为 `Read HEARTBEAT.md if it exists...`），指示 Agent 检查任务。
- **静默协议**: 为了防止 Agent 每隔 30 分钟就给用户发一句 "I checked, nothing to do"，引入了 `HEARTBEAT_OK` 协议。
  - 如果 Agent 认为无需打扰用户，只需回复 `HEARTBEAT_OK`。
  - 网关 (Gateway) 会拦截这个回复，不向用户发送任何消息。
  - 如果回复中包含其他内容（如报警信息），则会正常发送给用户。

### 2.2 实践配置

默认情况下，心跳每 30 分钟运行一次。

**配置文件 (`openclaw.json` 或 `config.json`):**

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 频率
        target: "last", // 消息发送目标 (例如最后联系的渠道)
        activeHours: {
          // 仅在活跃时间段运行，避免半夜打扰
          start: "09:00",
          end: "22:00",
          timezone: "Asia/Shanghai",
        },
        // 自定义 Prompt，覆盖默认行为
        prompt: "Check the weather and calendar. If no rain and no meetings, reply HEARTBEAT_OK.",
      },
    },
  },
}
```

**HEARTBEAT.md**:
推荐在 Agent 的工作区创建一个 `HEARTBEAT.md` 文件，作为 Agent 的“例行检查清单”。

```markdown
# Heartbeat Checklist

- Check unread emails in Gmail.
- Check today's calendar events.
- If any urgent email or upcoming meeting in 30 mins, notify user.
- Otherwise, reply HEARTBEAT_OK.
```

### 2.3 代码实现关键点

- **调度器**: `src/infra/heartbeat-runner.ts` 负责计算下一次心跳时间，并调用 Agent 执行。
- **自动回复处理**: `src/auto-reply/heartbeat.ts` 定义了 `stripHeartbeatToken` 函数，用于检测并剥离 `HEARTBEAT_OK` 标记。

## 3. Cron 机制 (Cron Jobs)

### 3.1 原理

Cron 是 Gateway 内置的调度器，独立于 AI 模型运行。它类似于 Linux 的 crontab，但集成了 Agent 的能力。

- **存储**: 作业持久化存储在 `~/.openclaw/cron/` 目录下，重启不丢失。
- **执行模式**:
  1.  **Main Session (主会话模式)**: 向主会话注入一个系统事件 (System Event)。Agent 在收到事件后，在主会话中处理。
      - _适用场景_: 需要结合历史上下文的任务（例如：“提醒我刚才讨论的那个会议”）。
  2.  **Isolated (隔离模式)**: 启动一个新的、独立的会话 (`cron:<jobId>`) 运行 Agent。
      - _适用场景_: 耗时任务、不需要上下文的任务、或者需要使用不同模型（如更便宜的模型）的任务。

### 3.2 实践配置

可以通过 CLI (`openclaw cron`) 或 Agent 工具 (`cron.add`) 管理。

**CLI 示例:**

1.  **主会话提醒 (Main Session)**:

    ```bash
    # 每天早上 9 点在主会话中提醒
    openclaw cron add \
      --name "Daily Standup" \
      --cron "0 9 * * *" \
      --session main \
      --system-event "Time for daily standup meeting. Ask user for updates." \
      --wake now
    ```

2.  **独立任务 (Isolated)**:
    ```bash
    # 每周一运行深度分析，使用独立会话和更强的模型
    openclaw cron add \
      --name "Weekly Analysis" \
      --cron "0 8 * * 1" \
      --session isolated \
      --message "Analyze the project git logs for the last week and generate a report." \
      --model "anthropic/claude-3-opus" \
      --announce
    ```

### 3.3 代码实现关键点

- **服务层**: `src/cron/service.ts` 实现了调度逻辑、作业存储和执行触发。
- **工具层**: `src/agents/tools/cron-tool.ts` 允许 Agent 自己创建和管理 Cron 任务（Agent 可以“给自己定闹钟”）。
- **唤醒**: 支持 `wake: "now"` (立即唤醒 Agent) 或 `wake: "next-heartbeat"` (等到下一次心跳时顺便处理)。

## 4. 区别对比

| 特性           | Heartbeat (心跳)                         | Cron (定时任务)                                |
| :------------- | :--------------------------------------- | :--------------------------------------------- |
| **触发方式**   | 周期性间隔 (Every N minutes)             | 精确时间 (Cron 表达式) 或 间隔                 |
| **主要目的**   | 维持 Agent 活性，被动检查状态            | 执行特定任务，主动触发流程                     |
| **运行上下文** | **始终在主会话** (Main Session)          | 可选 **主会话** 或 **隔离会话**                |
| **上下文记忆** | 拥有完整对话历史                         | 主会话模式有记忆；隔离模式无记忆 (Clean Slate) |
| **输出行为**   | 默认静默 (`HEARTBEAT_OK`)，有事才说话    | 默认广播结果 (Announce) 或 Webhook             |
| **成本**       | 每次心跳消耗一次 LLM 推理 (即使无事发生) | 仅在任务执行时消耗                             |
| **典型用例**   | 检查邮件、日历、未读消息、系统状态监控   | 每日早报、周报生成、特定时间的提醒、数据抓取   |

## 5. 总结

- 如果你需要 Agent **像人一样**，时不时看一眼有没有新消息，或者根据当前聊天的上下文做一些后台处理，使用 **Heartbeat**。配合 `HEARTBEAT.md` 可以极大地增强 Agent 的自主性。
- 如果你需要 Agent **像机器一样**，在每天固定时间执行固定的工作流，或者任务非常繁重不希望干扰主对话流，使用 **Cron**。

这两种机制互为补充，共同构成了 OpenClaw 强大的自动化底座。
