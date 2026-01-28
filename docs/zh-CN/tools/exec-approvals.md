---
read_when:
  - 配置执行审批或允许列表
  - 在 macOS 应用中实现执行审批用户体验
  - 审查沙箱逃逸提示及其影响
summary: 执行审批、允许列表和沙箱逃逸提示
title: 执行审批
x-i18n:
  generated_at: "2026-02-01T21:42:40Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ed17aab60b1f9c797ea8e9143d39d3a500c7b8cad4ea4b7903fedbf799339d28
  source_path: tools/exec-approvals.md
  workflow: 15
---

# 执行审批

执行审批是**伴侣应用 / 节点主机的安全护栏**，用于允许沙箱隔离的智能体在真实主机（`gateway` 或 `node`）上运行命令。可以将其理解为一种安全联锁机制：只有当策略 + 允许列表 +（可选的）用户审批全部通过时，命令才会被允许执行。
执行审批是在工具策略和提权网关**之上**的额外检查（除非提权设置为 `full`，此时会跳过审批）。
生效策略取 `tools.exec.*` 和审批默认值中**更严格**的一个；如果审批字段被省略，则使用 `tools.exec` 的值。

如果伴侣应用 UI **不可用**，任何需要提示的请求将由 **ask 回退策略**（默认：deny）来决定。

## 适用范围

执行审批在执行主机上本地强制执行：

- **Gateway网关主机** → Gateway网关机器上的 `openclaw` 进程
- **节点主机** → 节点运行器（macOS 伴侣应用或无头节点主机）

macOS 拆分：

- **节点主机服务**通过本地 IPC 将 `system.run` 转发至 **macOS 应用**。
- **macOS 应用**强制执行审批并在 UI 上下文中执行命令。

## 设置与存储

审批配置存储在执行主机上的本地 JSON 文件中：

`~/.openclaw/exec-approvals.json`

示例结构：

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## 策略选项

### 安全级别（`exec.security`）

- **deny**：阻止所有主机执行请求。
- **allowlist**：仅允许在允许列表中的命令。
- **full**：允许所有命令（等同于提权模式）。

### 询问（`exec.ask`）

- **off**：从不提示。
- **on-miss**：仅在允许列表未匹配时提示。
- **always**：每次命令都提示。

### 询问回退（`askFallback`）

如果需要提示但无法连接到 UI，则由回退策略决定：

- **deny**：阻止。
- **allowlist**：仅在允许列表匹配时放行。
- **full**：放行。

## 允许列表（按智能体）

允许列表是**按智能体**配置的。如果存在多个智能体，可以在 macOS 应用中切换要编辑的智能体。匹配模式为**不区分大小写的 glob 匹配**。
模式应解析为**二进制路径**（仅包含基础名的条目会被忽略）。
旧版 `agents.default` 条目在加载时会被迁移到 `agents.main`。

示例：

- `~/Projects/**/bin/bird`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

每个允许列表条目跟踪以下信息：

- **id** 用于 UI 标识的稳定 UUID（可选）
- **最近使用**时间戳
- **最近使用的命令**
- **最近解析的路径**

## 自动允许 Skills CLI

启用**自动允许 Skills CLI** 后，已知 Skills 引用的可执行文件在节点上（macOS 节点或无头节点主机）会被视为已列入允许列表。此功能通过 Gateway网关 RPC 的 `skills.bins` 获取 Skills 二进制列表。如果需要严格的手动允许列表，请禁用此选项。

## 安全二进制（仅限标准输入）

`tools.exec.safeBins` 定义了一小组**仅限标准输入**的二进制文件（例如 `jq`），它们可以在允许列表模式下运行，**无需**显式添加到允许列表中。安全二进制会拒绝位置文件参数和类路径标记，因此只能操作传入的数据流。
Shell 链式调用和重定向在允许列表模式下不会被自动允许。

当每个顶层段都满足允许列表（包括安全二进制或 Skills 自动允许）时，Shell 链式调用（`&&`、`||`、`;`）是被允许的。重定向在允许列表模式下仍不受支持。

默认安全二进制：`jq`、`grep`、`cut`、`sort`、`uniq`、`head`、`tail`、`tr`、`wc`。

## 控制 UI 编辑

使用**控制 UI → 节点 → 执行审批**卡片来编辑默认值、按智能体的覆盖配置和允许列表。选择一个范围（默认值或某个智能体），调整策略，添加/删除允许列表模式，然后点击**保存**。UI 会显示每个模式的**最近使用**元数据，方便你保持列表整洁。

目标选择器可选择 **Gateway网关**（本地审批）或**节点**。节点必须广播 `system.execApprovals.get/set`（macOS 应用或无头节点主机）。
如果某个节点尚未广播执行审批功能，请直接编辑其本地的 `~/.openclaw/exec-approvals.json` 文件。

CLI：`openclaw approvals` 支持 Gateway网关或节点编辑（参见 [审批 CLI](/cli/approvals)）。

## 审批流程

当需要提示时，Gateway网关向操作员客户端广播 `exec.approval.requested`。
控制 UI 和 macOS 应用通过 `exec.approval.resolve` 进行处理，然后 Gateway网关将已批准的请求转发至节点主机。

当需要审批时，执行工具会立即返回一个审批 ID。使用该 ID 来关联后续的系统事件（`Exec finished` / `Exec denied`）。如果在超时前未收到决定，该请求将被视为审批超时并以拒绝原因呈现。

确认对话框包含：

- 命令 + 参数
- 工作目录
- 智能体 ID
- 解析后的可执行文件路径
- 主机 + 策略元数据

操作：

- **允许一次** → 立即运行
- **始终允许** → 添加到允许列表并运行
- **拒绝** → 阻止

## 审批转发至聊天渠道

你可以将执行审批提示转发到任何聊天渠道（包括插件渠道），并通过 `/approve` 进行审批。此功能使用常规的出站投递管道。

配置：

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // 子串或正则表达式
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

在聊天中回复：

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC 流程

```
Gateway网关 -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

安全说明：

- Unix 套接字模式 `0600`，令牌存储在 `exec-approvals.json` 中。
- 同 UID 对端检查。
- 质询/响应（nonce + HMAC 令牌 + 请求哈希）+ 短 TTL。

## 系统事件

执行生命周期以系统消息形式呈现：

- `Exec running`（仅当命令超过运行通知阈值时）
- `Exec finished`
- `Exec denied`

这些消息在节点报告事件后发布到智能体的会话中。
Gateway网关主机执行审批在命令完成时（以及可选地在运行时间超过阈值时）发出相同的生命周期事件。
经过审批网关的执行会复用审批 ID 作为这些消息中的 `runId`，便于关联。

## 影响

- **full** 权限很大；尽可能使用允许列表。
- **ask** 让你保持知情，同时仍允许快速审批。
- 按智能体的允许列表可防止一个智能体的审批泄漏到其他智能体。
- 审批仅适用于来自**授权发送者**的主机执行请求。未授权的发送者无法发出 `/exec`。
- `/exec security=full` 是面向授权操作员的会话级便捷功能，设计上会跳过审批。
  要彻底阻止主机执行，请将审批安全级别设为 `deny`，或通过工具策略拒绝 `exec` 工具。

相关内容：

- [执行工具](/tools/exec)
- [提权模式](/tools/elevated)
- [Skills](/tools/skills)
