---
read_when:
  - 不运行完整智能体回合直接调用工具
  - 构建需要工具策略强制执行的自动化
summary: 通过 Gateway 网关 HTTP 端点直接调用单个工具
title: 工具调用 API
x-i18n:
  generated_at: "2026-02-03T07:48:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 17ccfbe0b0d9bb61cc46fb21f5c09b106ba6e8e4c2c14135a11ca8d5b77b8a88
  source_path: gateway/tools-invoke-http-api.md
  workflow: 15
---

# 工具调用（HTTP）

OpenClaw 的 Gateway 网关暴露了一个简单的 HTTP 端点用于直接调用单个工具。它始终启用，但受 Gateway 网关认证和工具策略限制。

- `POST /tools/invoke`
- 与 Gateway 网关相同的端口（WS + HTTP 多路复用）：`http://<gateway-host>:<port>/tools/invoke`

默认最大负载大小为 2 MB。

## 认证

使用 Gateway 网关认证配置。发送 bearer 令牌：

- `Authorization: Bearer <token>`

说明：

- 当 `gateway.auth.mode="token"` 时，使用 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 当 `gateway.auth.mode="password"` 时，使用 `gateway.auth.password`（或 `OPENCLAW_GATEWAY_PASSWORD`）。

## 请求体

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

字段：

- `tool`（string，必需）：要调用的工具名称。
- `action`（string，可选）：如果工具 schema 支持 `action` 且 args 负载省略了它，则映射到 args。
- `args`（object，可选）：工具特定的参数。
- `sessionKey`（string，可选）：目标会话键。如果省略或为 `"main"`，Gateway 网关使用配置的主会话键（遵循 `session.mainKey` 和默认智能体，或在全局范围中使用 `global`）。
- `dryRun`（boolean，可选）：保留供将来使用；当前忽略。

## 策略 + 路由行为

工具可用性通过 Gateway 网关智能体使用的相同策略链过滤：

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- 群组策略（如果会话键映射到群组或渠道）
- 子智能体策略（使用子智能体会话键调用时）

如果工具不被策略允许，端点返回 **404**。

为帮助群组策略解析上下文，你可以选择设置：

- `x-openclaw-message-channel: <channel>`（示例：`slack`、`telegram`）
- `x-openclaw-account-id: <accountId>`（当存在多个账户时）

## 响应

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }`（无效请求或工具错误）
- `401` → 未授权
- `404` → 工具不可用（未找到或未在允许列表中）
- `405` → 方法不允许

## 示例

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
