---
read_when:
  - 集成需要 OpenAI Chat Completions 的工具
summary: 从 Gateway网关暴露一个兼容 OpenAI 的 /v1/chat/completions HTTP 端点
title: OpenAI Chat Completions
x-i18n:
  generated_at: "2026-02-01T20:35:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6f935777f489bff925a3bf18b1e4b7493f83ae7b1e581890092e5779af59b732
  source_path: gateway/openai-http-api.md
  workflow: 14
---

# OpenAI Chat Completions (HTTP)

OpenClaw 的 Gateway网关可以提供一个小型的兼容 OpenAI 的 Chat Completions 端点。

此端点**默认禁用**。请先在配置中启用它。

- `POST /v1/chat/completions`
- 与 Gateway网关使用相同端口（WS + HTTP 多路复用）：`http://<gateway-host>:<port>/v1/chat/completions`

在底层，请求会作为普通的 Gateway网关智能体运行来执行（与 `openclaw agent` 相同的代码路径），因此路由/权限/配置与你的 Gateway网关保持一致。

## 认证

使用 Gateway网关的认证配置。发送 Bearer 令牌：

- `Authorization: Bearer <token>`

注意：

- 当 `gateway.auth.mode="token"` 时，使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 当 `gateway.auth.mode="password"` 时，使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。

## 选择智能体

无需自定义请求头：在 OpenAI 的 `model` 字段中编码智能体 ID：

- `model: "openclaw:<agentId>"`（示例：`"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（别名）

或通过请求头指定特定的 OpenClaw 智能体：

- `x-openclaw-agent-id: <agentId>`（默认值：`main`）

高级用法：

- `x-openclaw-session-key: <sessionKey>` 用于完全控制会话路由。

## 启用端点

将 `gateway.http.endpoints.chatCompletions.enabled` 设置为 `true`：

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## 禁用端点

将 `gateway.http.endpoints.chatCompletions.enabled` 设置为 `false`：

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## 会话行为

默认情况下，端点**每次请求无状态**（每次调用生成一个新的会话密钥）。

如果请求中包含 OpenAI 的 `user` 字符串，Gateway网关会根据它派生一个稳定的会话密钥，这样重复调用可以共享同一个智能体会话。

## 流式传输 (SSE)

设置 `stream: true` 以接收服务器发送事件 (SSE)：

- `Content-Type: text/event-stream`
- 每个事件行格式为 `data: <json>`
- 流以 `data: [DONE]` 结束

## 示例

非流式：

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

流式：

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
