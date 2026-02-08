---
read_when:
  - 设计 exec 主机路由或 exec 批准
  - 实现节点运行器 + UI IPC
  - 添加 exec 主机安全模式和斜杠命令
summary: 重构计划：exec 主机路由、节点批准和无头运行器
title: Exec 主机重构
x-i18n:
  generated_at: "2026-02-03T07:54:43Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 53a9059cbeb1f3f1dbb48c2b5345f88ca92372654fef26f8481e651609e45e3a
  source_path: refactor/exec-host.md
  workflow: 15
---

# Exec 主机重构计划

## 目标

- 添加 `exec.host` + `exec.security` 以在**沙箱**、**Gateway 网关**和**节点**之间路由执行。
- 保持默认**安全**：除非明确启用，否则不进行跨主机执行。
- 将执行拆分为**无头运行器服务**，通过本地 IPC 连接可选的 UI（macOS 应用）。
- 提供**每智能体**策略、允许列表、询问模式和节点绑定。
- 支持*与*或*不与*允许列表一起使用的**询问模式**。
- 跨平台：Unix socket + token 认证（macOS/Linux/Windows 一致性）。

## 非目标

- 无遗留允许列表迁移或遗留 schema 支持。
- 节点 exec 无 PTY/流式传输（仅聚合输出）。
- 除现有 Bridge + Gateway 网关外无新网络层。

## 决定（已锁定）

- **配置键：** `exec.host` + `exec.security`（允许每智能体覆盖）。
- **提升：** 保留 `/elevated` 作为 Gateway 网关完全访问的别名。
- **询问默认：** `on-miss`。
- **批准存储：** `~/.openclaw/exec-approvals.json`（JSON，无遗留迁移）。
- **运行器：** 无头系统服务；UI 应用托管 Unix socket 用于批准。
- **节点身份：** 使用现有 `nodeId`。
- **Socket 认证：** Unix socket + token（跨平台）；如需要稍后拆分。
- **节点主机状态：** `~/.openclaw/node.json`（节点 id + 配对 token）。
- **macOS exec 主机：** 在 macOS 应用内运行 `system.run`；节点主机服务通过本地 IPC 转发请求。
- **无 XPC helper：** 坚持使用 Unix socket + token + 对等检查。

## 关键概念

### 主机

- `sandbox`：Docker exec（当前行为）。
- `gateway`：在 Gateway 网关主机上执行。
- `node`：通过 Bridge 在节点运行器上执行（`system.run`）。

### 安全模式

- `deny`：始终阻止。
- `allowlist`：仅允许匹配项。
- `full`：允许一切（等同于提升模式）。

### 询问模式

- `off`：从不询问。
- `on-miss`：仅在允许列表不匹配时询问。
- `always`：每次都询问。

询问**独立于**允许列表；允许列表可与 `always` 或 `on-miss` 一起使用。

### 策略解析（每次执行）

1. 解析 `exec.host`（工具参数 → 智能体覆盖 → 全局默认）。
2. 解析 `exec.security` 和 `exec.ask`（相同优先级）。
3. 如果主机是 `sandbox`，继续本地沙箱执行。
4. 如果主机是 `gateway` 或 `node`，在该主机上应用安全 + 询问策略。

## 默认安全

- 默认 `exec.host = sandbox`。
- `gateway` 和 `node` 默认 `exec.security = deny`。
- 默认 `exec.ask = on-miss`（仅在安全允许时相关）。
- 如果未设置节点绑定，**智能体可以定向任何节点**，但仅在策略允许时。

## 配置表面

### 工具参数

- `exec.host`（可选）：`sandbox | gateway | node`。
- `exec.security`（可选）：`deny | allowlist | full`。
- `exec.ask`（可选）：`off | on-miss | always`。
- `exec.node`（可选）：当 `host=node` 时使用的节点 id/名称。

### 配置键（全局）

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node`（默认节点绑定）

### 配置键（每智能体）

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 别名

- `/elevated on` = 为智能体会话设置 `tools.exec.host=gateway`、`tools.exec.security=full`。
- `/elevated off` = 为智能体会话恢复之前的 exec 设置。

## 批准存储（JSON）

路径：`~/.openclaw/exec-approvals.json`

用途：

- **执行主机**（Gateway 网关或节点运行器）的本地策略 + 允许列表。
- 无 UI 可用时的询问回退。
- UI 客户端的 IPC 凭证。

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

- 无遗留允许列表格式。
- `askFallback` 仅在需要 `ask` 且无法访问 UI 时应用。
- 文件权限：`0600`。

## 运行器服务（无头）

### 角色

- 在本地强制执行 `exec.security` + `exec.ask`。
- 执行系统命令并返回输出。
- 为 exec 生命周期发出 Bridge 事件（可选但推荐）。

### 服务生命周期

- macOS 上的 Launchd/daemon；Linux/Windows 上的系统服务。
- 批准 JSON 是执行主机本地的。
- UI 托管本地 Unix socket；运行器按需连接。

## UI 集成（macOS 应用）

### IPC

- Unix socket 位于 `~/.openclaw/exec-approvals.sock`（0600）。
- Token 存储在 `exec-approvals.json`（0600）中。
- 对等检查：仅同 UID。
- 挑战/响应：nonce + HMAC(token, request-hash) 防止重放。
- 短 TTL（例如 10s）+ 最大负载 + 速率限制。

### 询问流程（macOS 应用 exec 主机）

1. 节点服务从 Gateway 网关接收 `system.run`。
2. 节点服务连接到本地 socket 并发送提示/exec 请求。
3. 应用验证对等 + token + HMAC + TTL，然后在需要时显示对话框。
4. 应用在 UI 上下文中执行命令并返回输出。
5. 节点服务将输出返回给 Gateway 网关。

如果 UI 缺失：

- 应用 `askFallback`（`deny|allowlist|full`）。

### 图示（SCI）

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## 节点身份 + 绑定

- 使用 Bridge 配对中的现有 `nodeId`。
- 绑定模型：
  - `tools.exec.node` 将智能体限制为特定节点。
  - 如果未设置，智能体可以选择任何节点（策略仍强制执行默认值）。
- 节点选择解析：
  - `nodeId` 精确匹配
  - `displayName`（规范化）
  - `remoteIp`
  - `nodeId` 前缀（>= 6 字符）

## 事件

### 谁看到事件

- 系统事件是**每会话**的，在下一个提示时显示给智能体。
- 存储在 Gateway 网关内存队列中（`enqueueSystemEvent`）。

### 事件文本

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 可选输出尾部
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 传输

选项 A（推荐）：

- 运行器发送 Bridge `event` 帧 `exec.started` / `exec.finished`。
- Gateway 网关 `handleBridgeEvent` 将这些映射到 `enqueueSystemEvent`。

选项 B：

- Gateway 网关 `exec` 工具直接处理生命周期（仅同步）。

## Exec 流程

### 沙箱主机

- 现有 `exec` 行为（Docker 或无沙箱时的主机）。
- 仅在非沙箱模式下支持 PTY。

### Gateway 网关主机

- Gateway 网关进程在其自己的机器上执行。
- 强制执行本地 `exec-approvals.json`（安全/询问/允许列表）。

### 节点主机

- Gateway 网关调用 `node.invoke` 配合 `system.run`。
- 运行器强制执行本地批准。
- 运行器返回聚合的 stdout/stderr。
- 可选的 Bridge 事件用于开始/完成/拒绝。

## 输出上限

- 组合 stdout+stderr 上限为 **200k**；为事件保留**尾部 20k**。
- 使用清晰的后缀截断（例如 `"… (truncated)"`）。

## 斜杠命令

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 每智能体、每会话覆盖；除非通过配置保存，否则非持久。
- `/elevated on|off|ask|full` 仍然是 `host=gateway security=full` 的快捷方式（`full` 跳过批准）。

## 跨平台方案

- 运行器服务是可移植的执行目标。
- UI 是可选的；如果缺失，应用 `askFallback`。
- Windows/Linux 支持相同的批准 JSON + socket 协议。

## 实现阶段

### 阶段 1：配置 + exec 路由

- 为 `exec.host`、`exec.security`、`exec.ask`、`exec.node` 添加配置 schema。
- 更新工具管道以遵守 `exec.host`。
- 添加 `/exec` 斜杠命令并保留 `/elevated` 别名。

### 阶段 2：批准存储 + Gateway 网关强制执行

- 实现 `exec-approvals.json` 读取器/写入器。
- 为 `gateway` 主机强制执行允许列表 + 询问模式。
- 添加输出上限。

### 阶段 3：节点运行器强制执行

- 更新节点运行器以强制执行允许列表 + 询问。
- 添加 Unix socket 提示桥接到 macOS 应用 UI。
- 连接 `askFallback`。

### 阶段 4：事件

- 为 exec 生命周期添加节点 → Gateway 网关 Bridge 事件。
- 映射到 `enqueueSystemEvent` 用于智能体提示。

### 阶段 5：UI 完善

- Mac 应用：允许列表编辑器、每智能体切换器、询问策略 UI。
- 节点绑定控制（可选）。

## 测试计划

- 单元测试：允许列表匹配（glob + 不区分大小写）。
- 单元测试：策略解析优先级（工具参数 → 智能体覆盖 → 全局）。
- 集成测试：节点运行器拒绝/允许/询问流程。
- Bridge 事件测试：节点事件 → 系统事件路由。

## 开放风险

- UI 不可用：确保遵守 `askFallback`。
- 长时间运行的命令：依赖超时 + 输出上限。
- 多节点歧义：除非有节点绑定或显式节点参数，否则报错。

## 相关文档

- [Exec 工具](/tools/exec)
- [执行批准](/tools/exec-approvals)
- [节点](/nodes)
- [提升模式](/tools/elevated)
