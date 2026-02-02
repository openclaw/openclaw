---
read_when:
  - 设计执行主机路由或执行审批
  - 实现节点运行器 + UI IPC
  - 添加执行主机安全模式和斜杠命令
summary: 重构计划：执行主机路由、节点审批和无头运行器
title: 执行主机重构
x-i18n:
  generated_at: "2026-02-01T21:36:56Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 53a9059cbeb1f3f1dbb48c2b5345f88ca92372654fef26f8481e651609e45e3a
  source_path: refactor/exec-host.md
  workflow: 15
---

# 执行主机重构计划

## 目标

- 添加 `exec.host` + `exec.security` 以在 **sandbox**、**gateway** 和 **node** 之间路由执行。
- 保持默认值**安全**：除非明确启用，否则不进行跨主机执行。
- 将执行拆分为**无头运行器服务**，并通过本地 IPC 提供可选 UI（macOS 应用）。
- 提供**按智能体**的策略、允许列表、询问模式和节点绑定。
- 支持与允许列表*配合*或*不配合*使用的**询问模式**。
- 跨平台：Unix socket + token 认证（macOS/Linux/Windows 一致性）。

## 非目标

- 不进行旧版允许列表迁移或旧版 schema 支持。
- 不为节点执行提供 PTY/流式输出（仅支持聚合输出）。
- 不在现有 Bridge + Gateway网关之外新增网络层。

## 决策（已锁定）

- **配置键：**`exec.host` + `exec.security`（允许按智能体覆盖）。
- **提权：**保留 `/elevated` 作为 gateway 完全访问的别名。
- **询问默认值：**`on-miss`。
- **审批存储：**`~/.openclaw/exec-approvals.json`（JSON，不迁移旧版）。
- **运行器：**无头系统服务；UI 应用托管 Unix socket 用于审批。
- **节点身份：**使用现有的 `nodeId`。
- **Socket 认证：**Unix socket + token（跨平台）；后续需要时再拆分。
- **节点主机状态：**`~/.openclaw/node.json`（节点 ID + 配对 token）。
- **macOS 执行主机：**在 macOS 应用内运行 `system.run`；节点主机服务通过本地 IPC 转发请求。
- **不使用 XPC helper：**坚持使用 Unix socket + token + 对端检查。

## 核心概念

### 主机

- `sandbox`：Docker 执行（当前行为）。
- `gateway`：在 gateway 主机上执行。
- `node`：通过 Bridge 在节点运行器上执行（`system.run`）。

### 安全模式

- `deny`：始终阻止。
- `allowlist`：仅允许匹配项。
- `full`：允许所有（等同于提权模式）。

### 询问模式

- `off`：从不询问。
- `on-miss`：仅在允许列表不匹配时询问。
- `always`：每次都询问。

询问与允许列表**相互独立**；允许列表可与 `always` 或 `on-miss` 配合使用。

### 策略解析（每次执行）

1. 解析 `exec.host`（工具参数 → 智能体覆盖 → 全局默认值）。
2. 解析 `exec.security` 和 `exec.ask`（相同优先级）。
3. 如果主机是 `sandbox`，使用本地沙箱执行。
4. 如果主机是 `gateway` 或 `node`，在该主机上应用安全 + 询问策略。

## 默认安全

- 默认 `exec.host = sandbox`。
- `gateway` 和 `node` 默认 `exec.security = deny`。
- 默认 `exec.ask = on-miss`（仅在安全策略允许时相关）。
- 如果未设置节点绑定，**智能体可以指向任何节点**，但仅在策略允许时。

## 配置接口

### 工具参数

- `exec.host`（可选）：`sandbox | gateway | node`。
- `exec.security`（可选）：`deny | allowlist | full`。
- `exec.ask`（可选）：`off | on-miss | always`。
- `exec.node`（可选）：当 `host=node` 时使用的节点 ID/名称。

### 配置键（全局）

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node`（默认节点绑定）

### 配置键（按智能体）

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 别名

- `/elevated on` = 为智能体会话设置 `tools.exec.host=gateway`、`tools.exec.security=full`。
- `/elevated off` = 为智能体会话恢复之前的执行设置。

## 审批存储（JSON）

路径：`~/.openclaw/exec-approvals.json`

用途：

- **执行主机**（gateway 或节点运行器）的本地策略 + 允许列表。
- 无 UI 可用时的询问回退。
- UI 客户端的 IPC 凭据。

建议的 schema（v1）：

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

注意事项：

- 不支持旧版允许列表格式。
- `askFallback` 仅在需要询问但无 UI 可达时生效。
- 文件权限：`0600`。

## 运行器服务（无头）

### 角色

- 在本地强制执行 `exec.security` + `exec.ask`。
- 执行系统命令并返回输出。
- 发送 Bridge 事件用于执行生命周期（可选但建议启用）。

### 服务生命周期

- macOS 上为 Launchd/daemon；Linux/Windows 上为系统服务。
- 审批 JSON 为执行主机本地文件。
- UI 托管本地 Unix socket；运行器按需连接。

## UI 集成（macOS 应用）

### IPC

- Unix socket 位于 `~/.openclaw/exec-approvals.sock`（0600）。
- Token 存储在 `exec-approvals.json`（0600）中。
- 对端检查：仅限相同 UID。
- 质询/响应：nonce + HMAC(token, request-hash) 以防止重放。
- 短 TTL（例如 10 秒）+ 最大负载 + 速率限制。

### 询问流程（macOS 应用执行主机）

1. 节点服务从 gateway 接收 `system.run`。
2. 节点服务连接本地 socket 并发送提示/执行请求。
3. 应用验证对端 + token + HMAC + TTL，然后在需要时显示对话框。
4. 应用在 UI 上下文中执行命令并返回输出。
5. 节点服务将输出返回给 gateway。

如果 UI 不可用：

- 应用 `askFallback`（`deny|allowlist|full`）。

### 图示（SCI）

```
Agent -> Gateway网关 -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## 节点身份 + 绑定

- 使用 Bridge 配对中现有的 `nodeId`。
- 绑定模型：
  - `tools.exec.node` 将智能体限制到特定节点。
  - 如果未设置，智能体可以选择任何节点（策略仍然强制执行默认值）。
- 节点选择解析：
  - `nodeId` 精确匹配
  - `displayName`（规范化）
  - `remoteIp`
  - `nodeId` 前缀（>= 6 个字符）

## 事件

### 谁可以看到事件

- 系统事件是**按会话**的，在下一个提示时展示给智能体。
- 存储在 gateway 的内存队列中（`enqueueSystemEvent`）。

### 事件文本

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 可选的输出尾部
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 传输

方案 A（推荐）：

- 运行器发送 Bridge `event` 帧 `exec.started` / `exec.finished`。
- Gateway网关 `handleBridgeEvent` 将其映射为 `enqueueSystemEvent`。

方案 B：

- Gateway网关 `exec` 工具直接处理生命周期（仅同步）。

## 执行流程

### Sandbox 主机

- 现有 `exec` 行为（Docker 或非沙箱时的主机执行）。
- 仅在非沙箱模式下支持 PTY。

### Gateway网关主机

- Gateway网关进程在自身机器上执行。
- 强制执行本地 `exec-approvals.json`（安全/询问/允许列表）。

### Node 主机

- Gateway网关通过 `node.invoke` 调用 `system.run`。
- 运行器强制执行本地审批。
- 运行器返回聚合的 stdout/stderr。
- 可选的 Bridge 事件用于启动/完成/拒绝。

## 输出限制

- stdout+stderr 合计上限为 **200k**；事件保留**尾部 20k**。
- 截断时添加明确后缀（例如 `"… (truncated)"`）。

## 斜杠命令

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 按智能体、按会话覆盖；除非通过配置保存，否则不持久化。
- `/elevated on|off|ask|full` 仍作为 `host=gateway security=full` 的快捷方式（`full` 跳过审批）。

## 跨平台方案

- 运行器服务是可移植的执行目标。
- UI 是可选的；如果不可用，则应用 `askFallback`。
- Windows/Linux 支持相同的审批 JSON + socket 协议。

## 实施阶段

### 阶段 1：配置 + 执行路由

- 添加 `exec.host`、`exec.security`、`exec.ask`、`exec.node` 的配置 schema。
- 更新工具管道以遵循 `exec.host`。
- 添加 `/exec` 斜杠命令并保留 `/elevated` 别名。

### 阶段 2：审批存储 + gateway 强制执行

- 实现 `exec-approvals.json` 读写器。
- 为 `gateway` 主机强制执行允许列表 + 询问模式。
- 添加输出限制。

### 阶段 3：节点运行器强制执行

- 更新节点运行器以强制执行允许列表 + 询问。
- 添加 Unix socket 提示桥接到 macOS 应用 UI。
- 接入 `askFallback`。

### 阶段 4：事件

- 添加节点 → gateway 的 Bridge 事件用于执行生命周期。
- 映射到 `enqueueSystemEvent` 用于智能体提示。

### 阶段 5：UI 完善

- Mac 应用：允许列表编辑器、按智能体切换器、询问策略 UI。
- 节点绑定控制（可选）。

## 测试计划

- 单元测试：允许列表匹配（glob + 大小写不敏感）。
- 单元测试：策略解析优先级（工具参数 → 智能体覆盖 → 全局）。
- 集成测试：节点运行器拒绝/允许/询问流程。
- Bridge 事件测试：节点事件 → 系统事件路由。

## 未解决风险

- UI 不可用：确保 `askFallback` 被正确执行。
- 长时间运行的命令：依赖超时 + 输出限制。
- 多节点歧义：除非有节点绑定或明确的节点参数，否则报错。

## 相关文档

- [执行工具](/tools/exec)
- [执行审批](/tools/exec-approvals)
- [节点](/nodes)
- [提权模式](/tools/elevated)
