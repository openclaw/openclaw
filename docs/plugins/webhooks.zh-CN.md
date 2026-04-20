---
summary: "Webhooks 插件：用于可信外部自动化的认证 TaskFlow 入口"
read_when:
  - 你想从外部系统触发或驱动 TaskFlows
  - 你正在配置捆绑的 webhooks 插件
---

# Webhooks 插件

Webhooks 插件添加了认证的 HTTP 路由，将外部自动化绑定到 OpenClaw TaskFlows。

当你希望 Zapier、n8n、CI 作业或内部服务等可信系统创建和驱动托管 TaskFlows，而无需先编写自定义插件时，使用它。

## 运行位置

Webhooks 插件在 Gateway 进程内运行。

如果你的 Gateway 在另一台机器上运行，请在该 Gateway 主机上安装和配置插件，然后重启 Gateway。

## 配置路由

在 `plugins.entries.webhooks.config` 下设置配置：

```json5
{
  plugins: {
    entries: {
      webhooks: {
        enabled: true,
        config: {
          routes: {
            zapier: {
              path: "/plugins/webhooks/zapier",
              sessionKey: "agent:main:main",
              secret: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_WEBHOOK_SECRET",
              },
              controllerId: "webhooks/zapier",
              description: "Zapier TaskFlow 桥接",
            },
          },
        },
      },
    },
  },
}
```

路由字段：

- `enabled`：可选，默认为 `true`
- `path`：可选，默认为 `/plugins/webhooks/<routeId>`
- `sessionKey`：拥有绑定 TaskFlows 的必需会话
- `secret`：必需的共享密钥或 SecretRef
- `controllerId`：创建的托管流的可选控制器 id
- `description`：可选的操作员说明

支持的 `secret` 输入：

- 纯字符串
- 带有 `source: "env" | "file" | "exec"` 的 SecretRef

如果基于密钥的路由在启动时无法解析其密钥，插件会跳过该路由并记录警告，而不是暴露一个损坏的端点。

## 安全模型

每个路由都被信任以其配置的 `sessionKey` 的 TaskFlow 权限行事。

这意味着路由可以检查和修改该会话拥有的 TaskFlows，因此你应该：

- 为每个路由使用强唯一密钥
- 优先使用密钥引用而不是内联明文密钥
- 将路由绑定到最适合工作流的最窄会话
- 仅暴露你需要的特定 webhook 路径

插件应用：

- 共享密钥认证
- 请求体大小和超时保护
- 固定窗口速率限制
- 进行中请求限制
- 通过 `api.runtime.taskFlow.bindSession(...)` 的所有者绑定 TaskFlow 访问

## 请求格式

发送带有以下内容的 `POST` 请求：

- `Content-Type: application/json`
- `Authorization: Bearer <secret>` 或 `x-openclaw-webhook-secret: <secret>`

示例：

```bash
curl -X POST https://gateway.example.com/plugins/webhooks/zapier \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_SHARED_SECRET' \
  -d '{"action":"create_flow","goal":"Review inbound queue"}'
```

## 支持的操作

插件当前接受这些 JSON `action` 值：

- `create_flow`
- `get_flow`
- `list_flows`
- `find_latest_flow`
- `resolve_flow`
- `get_task_summary`
- `set_waiting`
- `resume_flow`
- `finish_flow`
- `fail_flow`
- `request_cancel`
- `cancel_flow`
- `run_task`

### `create_flow`

为路由的绑定会话创建托管 TaskFlow。

示例：

```json
{
  "action": "create_flow",
  "goal": "Review inbound queue",
  "status": "queued",
  "notifyPolicy": "done_only"
}
```

### `run_task`

在现有的托管 TaskFlow 内创建托管子任务。

允许的运行时：

- `subagent`
- `acp`

示例：

```json
{
  "action": "run_task",
  "flowId": "flow_123",
  "runtime": "acp",
  "childSessionKey": "agent:main:acp:worker",
  "task": "Inspect the next message batch"
}
```

## 响应形状

成功的响应返回：

```json
{
  "ok": true,
  "routeId": "zapier",
  "result": {}
}
```

被拒绝的请求返回：

```json
{
  "ok": false,
  "routeId": "zapier",
  "code": "not_found",
  "error": "TaskFlow not found.",
  "result": {}
}
```

插件有意从 webhook 响应中清除所有者/会话元数据。

## 相关文档

- [插件运行时 SDK](/plugins/sdk-runtime)
- [钩子和 webhooks 概述](/automation/hooks)
- [CLI webhooks](/cli/webhooks)