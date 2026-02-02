---
read_when:
  - 添加或修改 webhook 端点
  - 将外部系统接入 OpenClaw
summary: 用于唤醒和隔离式智能体运行的 Webhook 入口
title: Webhooks
x-i18n:
  generated_at: "2026-02-01T19:39:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f26b88864567be82366b1f66a4772ef2813c7846110c62fce6caf7313568265e
  source_path: automation/webhook.md
  workflow: 14
---

# Webhooks

Gateway网关可以暴露一个小型 HTTP webhook 端点用于外部触发。

## 启用

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

说明：

- 当 `hooks.enabled=true` 时，`hooks.token` 为必填项。
- `hooks.path` 默认为 `/hooks`。

## 认证

每个请求必须包含 hook 令牌。推荐使用请求头：

- `Authorization: Bearer <token>`（推荐）
- `x-openclaw-token: <token>`
- `?token=<token>`（已弃用；会记录警告，将在未来的主要版本中移除）

## 端点

### `POST /hooks/wake`

请求体：

```json
{ "text": "System line", "mode": "now" }
```

- `text` **必填**（字符串）：事件描述（例如 "New email received"）。
- `mode` 可选（`now` | `next-heartbeat`）：是否触发立即心跳（默认 `now`）或等待下一次周期性检查。

效果：

- 为**主**会话入队一个系统事件
- 如果 `mode=now`，触发立即心跳

### `POST /hooks/agent`

请求体：

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **必填**（字符串）：智能体处理的提示或消息。
- `name` 可选（字符串）：hook 的人类可读名称（例如 "GitHub"），用作会话摘要的前缀。
- `sessionKey` 可选（字符串）：用于标识智能体会话的键。默认为随机的 `hook:<uuid>`。使用一致的键可以在 hook 上下文中进行多轮对话。
- `wakeMode` 可选（`now` | `next-heartbeat`）：是否触发立即心跳（默认 `now`）或等待下一次周期性检查。
- `deliver` 可选（布尔值）：如果为 `true`，智能体的回复将发送到消息渠道。默认为 `true`。仅为心跳确认的回复会被自动跳过。
- `channel` 可选（字符串）：投递的消息渠道。可选值：`last`、`whatsapp`、`telegram`、`discord`、`slack`、`mattermost`（插件）、`signal`、`imessage`、`msteams`。默认为 `last`。
- `to` 可选（字符串）：渠道的接收方标识符（例如 WhatsApp/Signal 的电话号码、Telegram 的聊天 ID、Discord/Slack/Mattermost（插件）的频道 ID、Microsoft Teams 的会话 ID）。默认为主会话中的最后一个接收方。
- `model` 可选（字符串）：模型覆盖（例如 `anthropic/claude-3-5-sonnet` 或别名）。如果有模型限制，必须在允许的模型列表中。
- `thinking` 可选（字符串）：思维级别覆盖（例如 `low`、`medium`、`high`）。
- `timeoutSeconds` 可选（数字）：智能体运行的最大持续时间（秒）。

效果：

- 运行一次**隔离式**智能体轮次（使用独立的会话键）
- 始终将摘要发布到**主**会话
- 如果 `wakeMode=now`，触发立即心跳

### `POST /hooks/<name>`（映射）

自定义 hook 名称通过 `hooks.mappings` 解析（参见配置）。映射可以将任意请求体转换为 `wake` 或 `agent` 操作，并支持可选的模板或代码转换。

映射选项（概要）：

- `hooks.presets: ["gmail"]` 启用内置的 Gmail 映射。
- `hooks.mappings` 允许你在配置中定义 `match`、`action` 和模板。
- `hooks.transformsDir` + `transform.module` 加载 JS/TS 模块以实现自定义逻辑。
- 使用 `match.source` 保持通用的接收端点（基于请求体的路由）。
- TS 转换需要 TS 加载器（例如 `bun` 或 `tsx`）或运行时预编译的 `.js`。
- 在映射上设置 `deliver: true` + `channel`/`to` 可将回复路由到聊天界面（`channel` 默认为 `last`，回退到 WhatsApp）。
- `allowUnsafeExternalContent: true` 为该 hook 禁用外部内容安全包装（危险；仅限受信任的内部来源）。
- `openclaw webhooks gmail setup` 为 `openclaw webhooks gmail run` 写入 `hooks.gmail` 配置。完整的 Gmail watch 流程请参阅 [Gmail Pub/Sub](/automation/gmail-pubsub)。

## 响应

- `200` 用于 `/hooks/wake`
- `202` 用于 `/hooks/agent`（异步运行已启动）
- `401` 认证失败
- `400` 无效请求体
- `413` 请求体过大

## 示例

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### 使用不同的模型

在 agent 请求体（或映射）中添加 `model` 以覆盖该次运行的模型：

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

如果你设置了 `agents.defaults.models`，请确保覆盖的模型包含在其中。

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## 安全

- 将 hook 端点限制在 local loopback、tailnet 或受信任的反向代理之后。
- 使用专用的 hook 令牌；不要复用 Gateway网关认证令牌。
- 避免在 webhook 日志中包含敏感的原始请求体。
- Hook 请求体默认被视为不受信任的，并使用安全边界进行包装。如果你必须为特定 hook 禁用此功能，请在该 hook 的映射中设置 `allowUnsafeExternalContent: true`（危险）。
