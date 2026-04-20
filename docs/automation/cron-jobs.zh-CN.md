---
summary: "网关调度器的计划作业、webhook 和 Gmail PubSub 触发器"
read_when:
  - 计划后台作业或唤醒
  - 将外部触发器（webhook、Gmail）连接到 OpenClaw
  - 在心跳和 cron 之间为计划任务做选择
title: "计划任务"
---

# 计划任务（Cron）

Cron 是网关内置的调度器。它持久化作业，在正确的时间唤醒代理，并可以将输出传递回聊天频道或 webhook 端点。

## 快速开始

```bash
# 添加一次性提醒
openclaw cron add \
  --name "提醒" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "提醒：检查 cron 文档草案" \
  --wake now \
  --delete-after-run

# 检查您的作业
openclaw cron list

# 查看运行历史
openclaw cron runs --id <job-id>
```

## Cron 如何工作

- Cron 在 **网关进程内** 运行（不在模型内）。
- 作业持久化在 `~/.openclaw/cron/jobs.json`，因此重启不会丢失计划。
- 所有 cron 执行都会创建 [后台任务](/automation/tasks) 记录。
- 一次性作业（`--at`）默认在成功后自动删除。
- 隔离的 cron 运行在完成时会尽力关闭其 `cron:<jobId>` 会话的跟踪浏览器选项卡/进程，因此分离的浏览器自动化不会留下孤立的进程。
- 隔离的 cron 运行还可以防止过时的确认回复。如果第一个结果只是临时状态更新（`正在处理`、`正在整理所有内容` 等类似提示），并且没有后代子代理运行仍负责最终答案，OpenClaw 会在交付前重新提示一次以获取实际结果。

<a id="maintenance"></a>

cron 的任务协调由运行时拥有：活动的 cron 任务在 cron 运行时仍将该作业跟踪为运行状态时保持活跃，即使旧的子会话行仍然存在。一旦运行时停止拥有作业并且 5 分钟的宽限期过期，维护可以将任务标记为 `lost`。

## 调度类型

| 类型    | CLI 标志  | 描述                                             |
| ------- | --------- | ------------------------------------------------ |
| `at`    | `--at`    | 一次性时间戳（ISO 8601 或相对时间，如 `20m`）    |
| `every` | `--every` | 固定间隔                                          |
| `cron`  | `--cron`  | 5 字段或 6 字段 cron 表达式，可选 `--tz`         |

没有时区的时间戳被视为 UTC。添加 `--tz America/New_York` 进行本地壁钟调度。

每小时顶部的重复表达式会自动错开最多 5 分钟，以减少负载高峰。使用 `--exact` 强制精确计时或 `--stagger 30s` 进行显式窗口设置。

### 月日和星期几使用 OR 逻辑

Cron 表达式由 [croner](https://github.com/Hexagon/croner) 解析。当月份日期和星期几字段都非通配符时，croner 会在 **任一** 字段匹配时匹配 — 而不是两者都匹配。这是标准的 Vixie cron 行为。

```
# 预期："15 号上午 9 点，仅当是星期一"  
# 实际："每个 15 号上午 9 点，AND 每个星期一上午 9 点"
0 9 15 * 1
```

这会每月触发约 5–6 次，而不是每月 0–1 次。OpenClaw 在此使用 Croner 的默认 OR 行为。要同时要求两个条件，请使用 Croner 的 `+` 星期几修饰符（`0 9 15 * +1`）或在一个字段上调度并在作业的提示或命令中保护另一个字段。

## 执行风格

| 风格           | `--session` 值   | 运行位置                  | 最适合                        |
| --------------- | ------------------- | ------------------------ | ------------------------------- |
| 主会话          | `main`              | 下一个心跳轮次            | 提醒，系统事件                 |
| 隔离            | `isolated`          | 专用 `cron:<jobId>`       | 报告，后台杂务                 |
| 当前会话        | `current`           | 创建时绑定                | 上下文感知的重复工作           |
| 自定义会话      | `session:custom-id` | 持久命名会话              | 基于历史构建的工作流           |

**主会话** 作业入队系统事件并可选唤醒心跳（`--wake now` 或 `--wake next-heartbeat`）。**隔离** 作业使用新鲜会话运行专用代理轮次。**自定义会话**（`session:xxx`）在运行之间保持上下文，启用像每日站会这样的工作流，这些工作流建立在以前的摘要之上。

对于隔离作业，运行时拆卸现在包括对该 cron 会话的尽力浏览器清理。清理失败被忽略，因此实际的 cron 结果仍然有效。

当隔离的 cron 运行编排子代理时，交付也优先于过时的父临时文本而选择最终的后代输出。如果后代仍在运行，OpenClaw 会抑制该部分父更新而不是宣布它。

### 隔离作业的负载选项

- `--message`：提示文本（隔离作业必需）
- `--model` / `--thinking`：模型和思考级别覆盖
- `--light-context`：跳过工作区引导文件注入
- `--tools exec,read`：限制作业可以使用的工具

`--model` 对该作业使用选定的允许模型。如果请求的模型不被允许，cron 会记录警告并回退到作业的代理/默认模型选择。配置的回退链仍然适用，但带有 `--model` 覆盖但没有显式每作业回退列表的操作不再将代理主模型追加为隐藏的额外重试目标。

隔离作业的模型选择优先级为：

1. Gmail 钩子模型覆盖（当运行来自 Gmail 且该覆盖被允许时）
2. 每作业负载 `model`
3. 存储的 cron 会话模型覆盖
4. 代理/默认模型选择

快速模式也遵循解析的实时选择。如果所选模型配置具有 `params.fastMode`，隔离的 cron 默认使用该模式。存储的会话 `fastMode` 覆盖仍然在任一方向上优于配置。

如果隔离运行遇到实时模型切换切换，cron 会使用切换的提供商/模型重试，并在重试前持久化该实时选择。当切换还携带新的身份验证配置文件时，cron 也会持久化该身份验证配置文件覆盖。重试是有限的：在初始尝试加上 2 次切换重试后，cron 会中止而不是永远循环。

## 交付和输出

| 模式       | 发生什么                                             |
| ---------- | -------------------------------------------------------- |
| `announce` | 将摘要交付到目标频道（隔离作业的默认值） |
| `webhook`  | 将完成的事件负载 POST 到 URL                     |
| `none`     | 仅限内部，无交付                               |

使用 `--announce --channel telegram --to "-1001234567890"` 进行频道交付。对于 Telegram 论坛主题，使用 `-1001234567890:topic:123`。Slack/Discord/Mattermost 目标应使用显式前缀（`channel:<id>`，`user:<id>`）。

对于 cron 拥有的隔离作业，运行器拥有最终的交付路径。代理被提示返回纯文本摘要，然后该摘要通过 `announce`、`webhook` 发送，或为 `none` 保持内部。`--no-deliver` 不会将交付交还给代理；它将运行保持在内部。

如果原始任务明确表示要向某些外部收件人发送消息，代理应在其输出中注明该消息应该发送给谁/在哪里，而不是尝试直接发送。

失败通知遵循单独的目标路径：

- `cron.failureDestination` 设置失败通知的全局默认值。
- `job.delivery.failureDestination` 按作业覆盖该默认值。
- 如果两者都未设置且作业已通过 `announce` 交付，失败通知现在会回退到该主要通知目标。
- `delivery.failureDestination` 仅在 `sessionTarget="isolated"` 作业上受支持，除非主要交付模式是 `webhook`。

## CLI 示例

一次性提醒（主会话）：

```bash
openclaw cron add \
  --name "日历检查" \
  --at "20m" \
  --session main \
  --system-event "下一次心跳：检查日历。" \
  --wake now
```

带交付的重复隔离作业：

```bash
openclaw cron add \
  --name "晨间简报" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "总结夜间更新。" \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

带模型和思考覆盖的隔离作业：

```bash
openclaw cron add \
  --name "深度分析" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "项目进度的每周深度分析。" \
  --model "opus" \
  --thinking high \
  --announce
```

## Webhooks

网关可以为外部触发器公开 HTTP webhook 端点。在配置中启用：

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

### 身份验证

每个请求必须通过标头包含钩子令牌：

- `Authorization: Bearer <token>`（推荐）
- `x-openclaw-token: <token>`

查询字符串令牌被拒绝。

### POST /hooks/wake

为主会话入队系统事件：

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"收到新邮件","mode":"now"}'
```

- `text`（必需）：事件描述
- `mode`（可选）：`now`（默认）或 `next-heartbeat`

### POST /hooks/agent

运行隔离的代理轮次：

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"总结收件箱","name":"邮件","model":"openai/gpt-5.4-mini"}'
```

字段：`message`（必需），`name`，`agentId`，`wakeMode`，`deliver`，`channel`，`to`，`model`，`thinking`，`timeoutSeconds`。

### 映射的钩子（POST /hooks/\<name\>）

自定义钩子名称通过配置中的 `hooks.mappings` 解析。映射可以将任意负载转换为带有模板或代码转换的 `wake` 或 `agent` 操作。

### 安全

- 将钩子端点保持在环回、tailnet 或受信任的反向代理后面。
- 使用专用的钩子令牌；不要重用网关身份验证令牌。
- 将 `hooks.path` 保持在专用子路径上；`/` 被拒绝。
- 设置 `hooks.allowedAgentIds` 以限制显式 `agentId` 路由。
- 保持 `hooks.allowRequestSessionKey=false` 除非您需要调用者选择的会话。
- 如果启用 `hooks.allowRequestSessionKey`，还应设置 `hooks.allowedSessionKeyPrefixes` 来约束允许的会话键形状。
- 钩子负载默认用安全边界包装。

## Gmail PubSub 集成

通过 Google PubSub 将 Gmail 收件箱触发器连接到 OpenClaw。

**先决条件**：`gcloud` CLI，`gog`（gogcli），启用 OpenClaw 钩子，用于公共 HTTPS 端点的 Tailscale。

### 向导设置（推荐）

```bash
openclaw webhooks gmail setup --account openclaw@gmail.com
```

这会写入 `hooks.gmail` 配置，启用 Gmail 预设，并使用 Tailscale Funnel 作为推送端点。

### 网关自动启动

当 `hooks.enabled=true` 且设置了 `hooks.gmail.account` 时，网关在启动时启动 `gog gmail watch serve` 并自动续订监视。设置 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 以选择退出。

### 手动一次性设置

1. 选择拥有 `gog` 使用的 OAuth 客户端的 GCP 项目：

```bash
gcloud auth login
gcloud config set project <project-id>
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

2. 创建主题并授予 Gmail 推送访问权限：

```bash
gcloud pubsub topics create gog-gmail-watch
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

3. 开始监视：

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

### Gmail 模型覆盖

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

## 管理作业

```bash
# 列出所有作业
openclaw cron list

# 编辑作业
openclaw cron edit <jobId> --message "更新的提示" --model "opus"

# 立即强制运行作业
openclaw cron run <jobId>

# 仅在到期时运行
openclaw cron run <jobId> --due

# 查看运行历史
openclaw cron runs --id <jobId> --limit 50

# 删除作业
openclaw cron remove <jobId>

# 代理选择（多代理设置）
openclaw cron add --name "运维扫描" --cron "0 6 * * *" --session isolated --message "检查运维队列" --agent ops
openclaw cron edit <jobId> --clear-agent
```

模型覆盖说明：

- `openclaw cron add|edit --model ...` 更改作业的选定模型。
- 如果模型被允许，该确切的提供商/模型会到达隔离的代理运行。
- 如果不被允许，cron 会警告并回退到作业的代理/默认模型选择。
- 配置的回退链仍然适用，但带有 `--model` 覆盖但没有显式每作业回退列表的操作不再默认为代理主模型作为静默的额外重试目标。

## 配置

```json5
{
  cron: {
    enabled: true,
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1,
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 120000, 300000],
      retryOn: ["rate_limit", "overloaded", "network", "server_error"],
    },
    webhookToken: "replace-with-dedicated-webhook-token",
    sessionRetention: "24h",
    runLog: { maxBytes: "2mb", keepLines: 2000 },
  },
}
```

禁用 cron：`cron.enabled: false` 或 `OPENCLAW_SKIP_CRON=1`。

**一次性重试**：暂时错误（速率限制、过载、网络、服务器错误）最多重试 3 次，带有指数退避。永久错误立即禁用。

**重复重试**：重试之间的指数退避（30 秒到 60 分钟）。下一次成功运行后，退避重置。

**维护**：`cron.sessionRetention`（默认 `24h`）会修剪隔离的运行会话条目。`cron.runLog.maxBytes` / `cron.runLog.keepLines` 会自动修剪运行日志文件。

## 故障排除

### 命令阶梯

```bash
openclaw status
openclaw gateway status
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
openclaw doctor
```

### Cron 不触发

- 检查 `cron.enabled` 和 `OPENCLAW_SKIP_CRON` 环境变量。
- 确认网关正在持续运行。
- 对于 `cron` 计划，验证时区（`--tz`）与主机时区。
- 运行输出中的 `reason: not-due` 意味着使用 `openclaw cron run <jobId> --due` 检查了手动运行，并且作业尚未到期。

### Cron 触发但无交付

- 交付模式为 `none` 意味着不期望外部消息。
- 交付目标缺失/无效（`channel`/`to`）意味着出站被跳过。
- 频道身份验证错误（`unauthorized`、`Forbidden`）意味着交付被凭据阻止。
- 如果隔离运行仅返回静默令牌（`NO_REPLY` / `no_reply`），OpenClaw 会抑制直接出站交付，也会抑制回退排队摘要路径，因此不会向聊天中发布任何内容。
- 对于 cron 拥有的隔离作业，不要期望代理使用消息工具作为回退。运行器拥有最终交付；`--no-deliver` 保持内部而不是允许直接发送。

### 时区陷阱

- 没有 `--tz` 的 Cron 使用网关主机时区。
- 没有时区的 `at` 计划被视为 UTC。
- 心跳 `activeHours` 使用配置的时区解析。

## 相关

- [自动化与任务](/automation) — 所有自动化机制一览
- [后台任务](/automation/tasks) — cron 执行的任务 ledger
- [心跳](/gateway/heartbeat) — 定期主会话轮次
- [时区](/concepts/timezone) — 时区配置