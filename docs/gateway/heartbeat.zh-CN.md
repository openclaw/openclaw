---
summary: "心跳轮询消息和通知规则"
read_when:
  - 调整心跳节奏或消息传递
  - 决定在计划任务中使用心跳还是定时任务
title: "心跳"
---

# 心跳（网关）

> **心跳 vs 定时任务？** 有关何时使用每个的指导，请参阅 [自动化和任务](/automation)。

心跳在主会话中运行**定期代理回合**，以便模型可以在不打扰你的情况下提醒任何需要注意的事项。

心跳是计划的主会话回合 —— 它**不会**创建 [后台任务](/automation/tasks) 记录。任务记录用于分离的工作（ACP 运行、子代理、隔离的定时任务）。

故障排除：[计划任务](/automation/cron-jobs#troubleshooting)

## 快速开始（初学者）

1. 保持心跳启用（默认是 `30m`，或对于 Anthropic OAuth/令牌认证（包括 Claude CLI 重用）是 `1h`）或设置你自己的节奏。
2. 在代理工作区中创建一个小的 `HEARTBEAT.md` 清单或 `tasks:` 块（可选但推荐）。
3. 决定心跳消息应该去哪里（默认是 `target: "none"`；设置 `target: "last"` 以路由到最后一个联系人）。
4. 可选：启用心跳推理传递以提高透明度。
5. 可选：如果心跳运行只需要 `HEARTBEAT.md`，则使用轻量级引导上下文。
6. 可选：启用隔离会话以避免在每次心跳时发送完整的对话历史记录。
7. 可选：将心跳限制在活动时间（本地时间）。

示例配置：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 显式传递给最后一个联系人（默认为 "none"）
        directPolicy: "allow", // 默认：允许直接/DM 目标；设置 "block" 以抑制
        lightContext: true, // 可选：仅从引导文件注入 HEARTBEAT.md
        isolatedSession: true, // 可选：每次运行都使用新会话（无对话历史）
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // 可选：也发送单独的 `Reasoning:` 消息
      },
    },
  },
}
```

## 默认值

- 间隔：`30m`（当检测到 Anthropic OAuth/令牌认证模式时为 `1h`，包括 Claude CLI 重用）。设置 `agents.defaults.heartbeat.every` 或每个代理的 `agents.list[].heartbeat.every`；使用 `0m` 禁用。
- 提示正文（可通过 `agents.defaults.heartbeat.prompt` 配置）：
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- 心跳提示**逐字**作为用户消息发送。当为默认代理启用心跳时，系统提示包含“心跳”部分，并且运行在内部被标记。
- 当心跳被 `0m` 禁用时，正常运行也会从引导上下文中省略 `HEARTBEAT.md`，因此模型不会看到仅心跳指令。
- 活动时间（`heartbeat.activeHours`）在配置的时区中检查。在窗口外，心跳会被跳过，直到窗口内的下一个 tick。

## 心跳提示的用途

默认提示有意广泛：

- **后台任务**：“Consider outstanding tasks” 提醒代理检查后续工作（收件箱、日历、提醒、排队工作）并提醒任何紧急事项。
- **人工检查**：“Checkup sometimes on your human during day time” 提醒偶尔的轻量级“你需要什么？”消息，但通过使用你配置的本地时区避免夜间打扰（见 [/concepts/timezone](/concepts/timezone)）。

心跳可以对已完成的 [后台任务](/automation/tasks) 做出反应，但心跳运行本身不会创建任务记录。

如果你希望心跳做一些非常具体的事情（例如“检查 Gmail PubSub 统计信息”或“验证网关健康状况”），将 `agents.defaults.heartbeat.prompt`（或 `agents.list[].heartbeat.prompt`）设置为自定义正文（逐字发送）。

## 响应约定

- 如果没有需要注意的事项，请回复 **`HEARTBEAT_OK`**。
- 在心跳运行期间，当 `HEARTBEAT_OK` 出现在回复的**开始或结束**时，OpenClaw 将其视为确认。如果剩余内容 **≤ `ackMaxChars`**（默认：300），则令牌被剥离，回复被丢弃。
- 如果 `HEARTBEAT_OK` 出现在回复的**中间**，则不会特别处理。
- 对于警报，**不要**包含 `HEARTBEAT_OK`；只返回警报文本。

在心跳之外，消息开始/结束处的零散 `HEARTBEAT_OK` 被剥离并记录；仅包含 `HEARTBEAT_OK` 的消息被丢弃。

## 配置

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 默认：30m（0m 禁用）
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // 默认：false（当可用时传递单独的 Reasoning: 消息）
        lightContext: false, // 默认：false；true 只保留工作区引导文件中的 HEARTBEAT.md
        isolatedSession: false, // 默认：false；true 在每个心跳中运行一个新会话（无对话历史）
        target: "last", // 默认：none | 选项：last | none | <channel id>（核心或插件，例如 "bluebubbles"）
        to: "+15551234567", // 可选的通道特定覆盖
        accountId: "ops-bot", // 可选的多账户通道 id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // HEARTBEAT_OK 后允许的最大字符数
      },
    },
  },
}
```

### 范围和优先级

- `agents.defaults.heartbeat` 设置全局心跳行为。
- `agents.list[].heartbeat` 在此基础上合并；如果任何代理有 `heartbeat` 块，**只有那些代理**运行心跳。
- `channels.defaults.heartbeat` 为所有通道设置可见性默认值。
- `channels.<channel>.heartbeat` 覆盖通道默认值。
- `channels.<channel>.accounts.<id>.heartbeat`（多账户通道）覆盖每通道设置。

### 每个代理的心跳

如果任何 `agents.list[]` 条目包含 `heartbeat` 块，**只有那些代理**运行心跳。每个代理块在此基础上合并 `agents.defaults.heartbeat`（因此你可以一次设置共享默认值并按代理覆盖）。

示例：两个代理，只有第二个代理运行心跳。

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 显式传递给最后一个联系人（默认为 "none"）
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          timeoutSeconds: 45,
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### 活动时间示例

将心跳限制在特定时区的工作时间：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 显式传递给最后一个联系人（默认为 "none"）
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // 可选；如果设置了 userTimezone，则使用，否则使用主机 tz
        },
      },
    },
  },
}
```

在此窗口外（东部时间上午 9 点前或晚上 10 点后），心跳会被跳过。窗口内的下一个计划 tick 将正常运行。

### 24/7 设置

如果你希望心跳全天运行，请使用以下模式之一：

- 完全省略 `activeHours`（无时间窗口限制；这是默认行为）。
- 设置全天窗口：`activeHours: { start: "00:00", end: "24:00" }`。

不要设置相同的 `start` 和 `end` 时间（例如 `08:00` 到 `08:00`）。这被视为零宽度窗口，因此心跳总是被跳过。

### 多账户示例

使用 `accountId` 在多账户通道（如 Telegram）上定位特定账户：

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // 可选：路由到特定主题/线程
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### 字段说明

- `every`：心跳间隔（持续时间字符串；默认单位 = 分钟）。
- `model`：心跳运行的可选模型覆盖（`provider/model`）。
- `includeReasoning`：启用时，当可用时也传递单独的 `Reasoning:` 消息（与 `/reasoning on` 相同的形状）。
- `lightContext`：当为 true 时，心跳运行使用轻量级引导上下文，并只保留工作区引导文件中的 `HEARTBEAT.md`。
- `isolatedSession`：当为 true 时，每个心跳在没有先前对话历史的新会话中运行。使用与定时任务 `sessionTarget: "isolated"` 相同的隔离模式。大大降低每次心跳的令牌成本。与 `lightContext: true` 结合使用以获得最大节省。传递路由仍然使用主会话上下文。
- `session`：心跳运行的可选会话键。
  - `main`（默认）：代理主会话。
  - 显式会话键（从 `openclaw sessions --json` 或 [sessions CLI](/cli/sessions) 复制）。
  - 会话键格式：请参阅 [会话](/concepts/session) 和 [群组](/channels/groups)。
- `target`：
  - `last`：传递到最后使用的外部通道。
  - 显式通道：任何配置的通道或插件 id，例如 `discord`、`matrix`、`telegram` 或 `whatsapp`。
  - `none`（默认）：运行心跳但**不外部传递**。
- `directPolicy`：控制直接/DM 传递行为：
  - `allow`（默认）：允许直接/DM 心跳传递。
  - `block`：抑制直接/DM 传递（`reason=dm-blocked`）。
- `to`：可选的收件人覆盖（通道特定 id，例如 WhatsApp 的 E.164 或 Telegram 聊天 id）。对于 Telegram 主题/线程，使用 `<chatId>:topic:<messageThreadId>`。
- `accountId`：多账户通道的可选账户 id。当 `target: "last"` 时，如果解析的最后通道支持账户，则账户 id 适用于该通道；否则它被忽略。如果账户 id 与解析通道的配置账户不匹配，则传递被跳过。
- `prompt`：覆盖默认提示正文（不合并）。
- `ackMaxChars`：`HEARTBEAT_OK` 后允许的最大字符数，然后再传递。
- `suppressToolErrorWarnings`：当为 true 时，在心跳运行期间抑制工具错误警告有效负载。
- `activeHours`：将心跳运行限制在时间窗口内。对象包含 `start`（HH:MM，包含；使用 `00:00` 表示一天开始）、`end`（HH:MM 不包含；允许 `24:00` 表示一天结束）和可选的 `timezone`。
  - 省略或 `"user"`：如果设置了 `agents.defaults.userTimezone`，则使用，否则回退到主机系统时区。
  - `"local"`：始终使用主机系统时区。
  - 任何 IANA 标识符（例如 `America/New_York`）：直接使用；如果无效，回退到上述的 `"user"` 行为。
  - `start` 和 `end` 对于活动窗口必须不相等；相等的值被视为零宽度（始终在窗口外）。
  - 在活动窗口外，心跳会被跳过，直到窗口内的下一个 tick。

## 传递行为

- 心跳默认在代理的主会话（`agent:<id>:<mainKey>`）中运行，或当 `session.scope = "global"` 时在 `global` 中运行。设置 `session` 以覆盖到特定的通道会话（Discord/WhatsApp 等）。
- `session` 仅影响运行上下文；传递由 `target` 和 `to` 控制。
- 要传递到特定通道/收件人，请设置 `target` + `to`。使用 `target: "last"`，传递使用该会话的最后一个外部通道。
- 心跳传递默认允许直接/DM 目标。设置 `directPolicy: "block"` 以在仍然运行心跳回合的同时抑制直接目标发送。
- 如果主队列繁忙，心跳会被跳过并稍后重试。
- 如果 `target` 解析为无外部目标，运行仍然会发生，但不会发送出站消息。
- 如果 `showOk`、`showAlerts` 和 `useIndicator` 都被禁用，运行会在前面被跳过，原因是 `reason=alerts-disabled`。
- 如果仅禁用警报传递，OpenClaw 仍然可以运行心跳，更新到期任务时间戳，恢复会话空闲时间戳，并抑制向外的警报有效负载。
- 仅心跳回复**不会**使会话保持活跃；最后一个 `updatedAt` 被恢复，因此空闲过期正常行为。
- 分离的 [后台任务](/automation/tasks) 可以入队系统事件并在主会话应该快速注意到某些内容时唤醒心跳。这种唤醒不会使心跳运行后台任务。

## 可见性控制

默认情况下，`HEARTBEAT_OK` 确认被抑制，而警报内容被传递。你可以按通道或按账户调整：

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # 隐藏 HEARTBEAT_OK（默认）
      showAlerts: true # 显示警报消息（默认）
      useIndicator: true # 发出指示器事件（默认）
  telegram:
    heartbeat:
      showOk: true # 在 Telegram 上显示 OK 确认
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # 为此账户抑制警报传递
```

优先级：每账户 → 每通道 → 通道默认值 → 内置默认值。

### 每个标志的作用

- `showOk`：当模型返回仅 OK 回复时发送 `HEARTBEAT_OK` 确认。
- `showAlerts`：当模型返回非 OK 回复时发送警报内容。
- `useIndicator`：为 UI 状态表面发出指示器事件。

如果**所有三个**都为 false，OpenClaw 会完全跳过心跳运行（无模型调用）。

### 每通道 vs 每账户示例

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # 所有 Slack 账户
    accounts:
      ops:
        heartbeat:
          showAlerts: false # 仅为此 ops 账户抑制警报
  telegram:
    heartbeat:
      showOk: true
```

### 常见模式

| 目标                          | 配置                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| 默认行为（静默 OK，警报开启） | _(无需配置)_                                                                             |
| 完全静默（无消息，无指示器）  | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 仅指示器（无消息）            | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 仅在一个通道中显示 OK         | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md（可选）

如果工作区中存在 `HEARTBEAT.md` 文件，默认提示会告诉代理读取它。将其视为你的“心跳清单”：小、稳定且每 30 分钟包含一次是安全的。

在正常运行中，只有当默认代理启用心跳指导时，才会注入 `HEARTBEAT.md`。用 `0m` 禁用心跳节奏或设置 `includeSystemPromptSection: false` 会将其从正常引导上下文中省略。

如果 `HEARTBEAT.md` 存在但实际上是空的（只有空行和 Markdown 标题，如 `# Heading`），OpenClaw 会跳过心跳运行以节省 API 调用。这种跳过被报告为 `reason=empty-heartbeat-file`。如果文件缺失，心跳仍然运行，模型决定做什么。

保持它很小（简短的清单或提醒）以避免提示膨胀。

示例 `HEARTBEAT.md`：

```md
# 心跳清单

- 快速扫描：收件箱中有什么紧急事项吗？
- 如果是白天，如果没有其他待处理事项，进行轻量级检查。
- 如果任务被阻塞，写下*缺少什么*，下次问 Peter。
```

### `tasks:` 块

`HEARTBEAT.md` 还支持一个小的结构化 `tasks:` 块，用于心跳内部的基于间隔的检查。

示例：

```md
tasks:

- name: inbox-triage
  interval: 30m
  prompt: "检查紧急未读邮件并标记任何时间敏感的内容。"
- name: calendar-scan
  interval: 2h
  prompt: "检查需要准备或跟进的即将到来的会议。"

# 额外说明

- 保持警报简短。
- 如果所有到期任务后没有需要注意的事项，回复 HEARTBEAT_OK。
```

行为：

- OpenClaw 解析 `tasks:` 块并根据每个任务自己的 `interval` 检查它。
- 只有**到期**的任务才会包含在该 tick 的心跳提示中。
- 如果没有任务到期，心跳会完全跳过（`reason=no-tasks-due`）以避免浪费模型调用。
- `HEARTBEAT.md` 中的非任务内容被保留并作为额外上下文附加在到期任务列表之后。
- 任务最后运行时间戳存储在会话状态（`heartbeatTaskState`）中，因此间隔在正常重启后仍然有效。
- 任务时间戳仅在心跳运行完成其正常回复路径后才会推进。跳过的 `empty-heartbeat-file` / `no-tasks-due` 运行不会将任务标记为已完成。

任务模式在你希望一个心跳文件包含多个定期检查而无需在每次 tick 为所有检查付费时很有用。

### 代理可以更新 HEARTBEAT.md 吗？

是的 —— 如果你要求它。

`HEARTBEAT.md` 只是代理工作区中的普通文件，所以你可以在正常聊天中告诉代理：

- “更新 `HEARTBEAT.md` 添加每日日历检查。”
- “重写 `HEARTBEAT.md` 使其更短，专注于收件箱跟进。”

如果你希望这主动发生，你也可以在心跳提示中包含明确的行，例如：“如果清单变得陈旧，用更好的清单更新 HEARTBEAT.md。”

安全注意：不要将机密（API 密钥、电话号码、私人令牌）放入 `HEARTBEAT.md` —— 它会成为提示上下文的一部分。

## 手动唤醒（按需）

你可以入队系统事件并触发立即心跳：

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

如果多个代理配置了 `heartbeat`，手动唤醒会立即运行每个代理的心跳。

使用 `--mode next-heartbeat` 等待下一个计划的 tick。

## 推理传递（可选）

默认情况下，心跳仅传递最终的“答案”有效负载。

如果你想要透明度，请启用：

- `agents.defaults.heartbeat.includeReasoning: true`

启用后，心跳还会传递一个前缀为 `Reasoning:` 的单独消息（与 `/reasoning on` 相同的形状）。当代理管理多个会话/代码库并且你想看到它决定 ping 你的原因时，这可能很有用 —— 但它也可能泄漏比你想要的更多的内部细节。在群组聊天中最好保持关闭。

## 成本意识

心跳运行完整的代理回合。更短的间隔会消耗更多令牌。为降低成本：

- 使用 `isolatedSession: true` 避免发送完整的对话历史（每次运行从约 100K 令牌减少到约 2-5K）。
- 使用 `lightContext: true` 将引导文件限制为仅 `HEARTBEAT.md`。
- 设置更便宜的 `model`（例如 `ollama/llama3.2:1b`）。
- 保持 `HEARTBEAT.md` 小。
- 如果你只想要内部状态更新，使用 `target: "none"`。

## 相关

- [自动化和任务](/automation) — 所有自动化机制一览
- [后台任务](/automation/tasks) — 如何跟踪分离的工作
- [时区](/concepts/timezone) — 时区如何影响心跳调度
- [故障排除](/automation/cron-jobs#troubleshooting) — 调试自动化问题
