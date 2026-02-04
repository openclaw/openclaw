---
read_when:
  - 调度后台任务或唤醒
  - 配置需要与心跳一起运行或配合运行的自动化任务
  - 决定计划任务使用心跳还是定时任务
summary: Gateway 网关调度器的定时任务与唤醒机制
title: 定时任务
x-i18n:
  generated_at: "2026-02-03T07:44:30Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d43268b0029f1b13d0825ddcc9c06a354987ea17ce02f3b5428a9c68bf936676
  source_path: automation/cron-jobs.md
  workflow: 15
---

# 定时任务（Gateway 网关调度器）

> **定时任务还是心跳？** 请参阅[定时任务与心跳对比](/automation/cron-vs-heartbeat)了解何时使用哪种方式。

定时任务是 Gateway 网关内置的调度器。它持久化任务，在正确的时间唤醒智能体，并可选择将输出发送回聊天。

如果你需要"每天早上运行这个"或"20 分钟后触发智能体"，定时任务就是实现机制。

## 简要概述

- 定时任务运行在 **Gateway 网关内部**（不是在模型内部）。
- 任务持久化存储在 `~/.openclaw/cron/` 下，因此重启不会丢失计划。
- 两种执行方式：
  - **主会话**：将系统事件加入队列，然后在下一次心跳时运行。
  - **隔离**：在 `cron:<jobId>` 中运行专用的智能体回合，可选择发送输出。
- 唤醒是一等功能：任务可以请求"立即唤醒"或"下次心跳"。

## 快速开始（可操作）

创建一个一次性提醒，验证它是否存在，然后立即运行：

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id> --force
openclaw cron runs --id <job-id>
```

调度一个带消息发送的循环隔离任务：

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --deliver \
  --channel slack \
  --to "channel:C1234567890"
```

## 工具调用等效项（Gateway 网关定时任务工具）

有关规范的 JSON 结构和示例，请参阅[工具调用的 JSON schema](/automation/cron-jobs#json-schema-for-tool-calls)。

## 定时任务的存储位置

定时任务默认持久化存储在 Gateway 网关主机的 `~/.openclaw/cron/jobs.json`。Gateway 网关将文件加载到内存中，并在更改时写回，因此只有在 Gateway 网关停止时手动编辑才是安全的。建议使用 `openclaw cron add/edit` 或定时任务工具调用 API 进行更改。

## 新手友好概述

将定时任务理解为：**何时**运行 + **做什么**。

1. **选择计划**
   - 一次性提醒 → `schedule.kind = "at"`（CLI：`--at`）
   - 重复任务 → `schedule.kind = "every"` 或 `schedule.kind = "cron"`
   - 如果你的 ISO 时间戳省略了时区，它将被视为 **UTC**。

2. **选择运行位置**
   - `sessionTarget: "main"` → 在下一次心跳时使用主上下文运行。
   - `sessionTarget: "isolated"` → 在 `cron:<jobId>` 中运行专用的智能体回合。

3. **选择负载**
   - 主会话 → `payload.kind = "systemEvent"`
   - 隔离会话 → `payload.kind = "agentTurn"`

可选：`deleteAfterRun: true` 会在成功执行后从存储中删除一次性任务。

## 概念

### 任务

定时任务是一个存储的记录，包含：

- 一个**计划**（何时运行），
- 一个**负载**（做什么），
- 可选的**发送**（输出发送到哪里）。
- 可选的**智能体绑定**（`agentId`）：在特定智能体下运行任务；如果缺失或未知，Gateway 网关会回退到默认智能体。

任务通过稳定的 `jobId` 标识（供 CLI/Gateway 网关 API 使用）。在智能体工具调用中，`jobId` 是规范名称；为了兼容性也接受旧版的 `id`。任务可以通过 `deleteAfterRun: true` 选择在一次性成功运行后自动删除。

### 计划

定时任务支持三种计划类型：

- `at`：一次性时间戳（自纪元以来的毫秒数）。Gateway 网关接受 ISO 8601 并转换为 UTC。
- `every`：固定间隔（毫秒）。
- `cron`：5 字段 cron 表达式，带可选的 IANA 时区。

Cron 表达式使用 `croner`。如果省略时区，则使用 Gateway 网关主机的本地时区。

### 主会话与隔离执行

#### 主会话任务（系统事件）

主任务将系统事件加入队列并可选择唤醒心跳运行器。它们必须使用 `payload.kind = "systemEvent"`。

- `wakeMode: "next-heartbeat"`（默认）：事件等待下一次计划的心跳。
- `wakeMode: "now"`：事件触发立即心跳运行。

当你需要正常的心跳提示 + 主会话上下文时，这是最佳选择。参见[心跳](/gateway/heartbeat)。

#### 隔离任务（专用定时会话）

隔离任务在会话 `cron:<jobId>` 中运行专用的智能体回合。

关键行为：

- 提示以 `[cron:<jobId> <job name>]` 为前缀以便追踪。
- 每次运行启动一个**新的会话 id**（没有先前的对话延续）。
- 摘要会发布到主会话（前缀 `Cron`，可配置）。
- `wakeMode: "now"` 在发布摘要后触发立即心跳。
- 如果 `payload.deliver: true`，输出会发送到渠道；否则保持内部。

对于嘈杂、频繁或不应该刷屏主聊天历史的"后台杂务"，使用隔离任务。

### 负载结构（运行什么）

支持两种负载类型：

- `systemEvent`：仅限主会话，通过心跳提示路由。
- `agentTurn`：仅限隔离会话，运行专用的智能体回合。

常见的 `agentTurn` 字段：

- `message`：必需的文本提示。
- `model` / `thinking`：可选覆盖（见下文）。
- `timeoutSeconds`：可选的超时覆盖。
- `deliver`：`true` 则将输出发送到渠道目标。
- `channel`：`last` 或特定渠道。
- `to`：特定于渠道的目标（电话/聊天/频道 id）。
- `bestEffortDeliver`：发送失败时避免任务失败。

隔离选项（仅适用于 `session=isolated`）：

- `postToMainPrefix`（CLI：`--post-prefix`）：主会话中系统事件的前缀。
- `postToMainMode`：`summary`（默认）或 `full`。
- `postToMainMaxChars`：当 `postToMainMode=full` 时的最大字符数（默认 8000）。

### 模型和思考覆盖

隔离任务（`agentTurn`）可以覆盖模型和思考级别：

- `model`：提供商/模型字符串（例如 `anthropic/claude-sonnet-4-20250514`）或别名（例如 `opus`）
- `thinking`：思考级别（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`；仅限 GPT-5.2 + Codex 模型）

注意：你也可以在主会话任务上设置 `model`，但它会更改共享的主会话模型。我们建议仅对隔离任务使用模型覆盖，以避免意外的上下文切换。

解析优先级：

1. 任务负载覆盖（最高）
2. 钩子特定默认值（例如 `hooks.gmail.model`）
3. 智能体配置默认值

### 发送（渠道 + 目标）

隔离任务可以将输出发送到渠道。任务负载可以指定：

- `channel`：`whatsapp` / `telegram` / `discord` / `slack` / `mattermost`（插件）/ `signal` / `imessage` / `last`
- `to`：特定于渠道的接收者目标

如果省略 `channel` 或 `to`，定时任务可以回退到主会话的"最后路由"（智能体最后回复的位置）。

发送说明：

- 如果设置了 `to`，即使省略了 `deliver`，定时任务也会自动发送智能体的最终输出。
- 当你想要不带显式 `to` 的最后路由发送时，使用 `deliver: true`。
- 使用 `deliver: false` 即使存在 `to` 也保持输出在内部。

目标格式提醒：

- Slack/Discord/Mattermost（插件）目标应使用显式前缀（例如 `channel:<id>`、`user:<id>`）以避免歧义。
- Telegram 话题应使用 `:topic:` 形式（见下文）。

#### Telegram 发送目标（话题/论坛帖子）

Telegram 通过 `message_thread_id` 支持论坛话题。对于定时任务发送，你可以将话题/帖子编码到 `to` 字段中：

- `-1001234567890`（仅聊天 id）
- `-1001234567890:topic:123`（推荐：显式话题标记）
- `-1001234567890:123`（简写：数字后缀）

带前缀的目标如 `telegram:...` / `telegram:group:...` 也被接受：

- `telegram:group:-1001234567890:topic:123`

## 工具调用的 JSON schema

直接调用 Gateway 网关 `cron.*` 工具时（智能体工具调用或 RPC）使用这些结构。CLI 标志接受人类可读的时间格式如 `20m`，但工具调用对 `atMs` 和 `everyMs` 使用纪元毫秒（`at` 时间接受 ISO 时间戳）。

### cron.add 参数

一次性，主会话任务（系统事件）：

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "atMs": 1738262400000 },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

循环，带发送的隔离任务：

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates.",
    "deliver": true,
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffortDeliver": true
  },
  "isolation": { "postToMainPrefix": "Cron", "postToMainMode": "summary" }
}
```

说明：

- `schedule.kind`：`at`（`atMs`）、`every`（`everyMs`）或 `cron`（`expr`，可选 `tz`）。
- `atMs` 和 `everyMs` 是纪元毫秒。
- `sessionTarget` 必须是 `"main"` 或 `"isolated"` 并且必须与 `payload.kind` 匹配。
- 可选字段：`agentId`、`description`、`enabled`、`deleteAfterRun`、`isolation`。
- `wakeMode` 省略时默认为 `"next-heartbeat"`。

### cron.update 参数

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

说明：

- `jobId` 是规范名称；为了兼容性也接受 `id`。
- 在补丁中使用 `agentId: null` 来清除智能体绑定。

### cron.run 和 cron.remove 参数

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 存储和历史

- 任务存储：`~/.openclaw/cron/jobs.json`（Gateway 网关管理的 JSON）。
- 运行历史：`~/.openclaw/cron/runs/<jobId>.jsonl`（JSONL，自动清理）。
- 覆盖存储路径：配置中的 `cron.store`。

## 配置

```json5
{
  cron: {
    enabled: true, // 默认 true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // 默认 1
  },
}
```

完全禁用定时任务：

- `cron.enabled: false`（配置）
- `OPENCLAW_SKIP_CRON=1`（环境变量）

## CLI 快速开始

一次性提醒（UTC ISO，成功后自动删除）：

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

一次性提醒（主会话，立即唤醒）：

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

循环隔离任务（发送到 WhatsApp）：

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --deliver \
  --channel whatsapp \
  --to "+15551234567"
```

循环隔离任务（发送到 Telegram 话题）：

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --deliver \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

带模型和思考覆盖的隔离任务：

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --deliver \
  --channel whatsapp \
  --to "+15551234567"
```

智能体选择（多智能体设置）：

```bash
# 将任务绑定到智能体"ops"（如果该智能体不存在则回退到默认）
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# 切换或清除现有任务的智能体
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

手动运行（调试）：

```bash
openclaw cron run <jobId> --force
```

编辑现有任务（补丁字段）：

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

运行历史：

```bash
openclaw cron runs --id <jobId> --limit 50
```

不创建任务的立即系统事件：

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway 网关 API 接口

- `cron.list`、`cron.status`、`cron.add`、`cron.update`、`cron.remove`
- `cron.run`（强制或到期）、`cron.runs`
  对于不创建任务的立即系统事件，使用 [`openclaw system event`](/cli/system)。

## 故障排除

### "什么都不运行"

- 检查定时任务是否启用：`cron.enabled` 和 `OPENCLAW_SKIP_CRON`。
- 检查 Gateway 网关是否持续运行（定时任务在 Gateway 网关进程内运行）。
- 对于 `cron` 计划：确认时区（`--tz`）与主机时区的关系。

### Telegram 发送到错误的位置

- 对于论坛话题，使用 `-100…:topic:<id>` 以确保明确无歧义。
- 如果你在日志或存储的"最后路由"目标中看到 `telegram:...` 前缀，这是正常的；定时任务发送接受它们并仍然正确解析话题 ID。
