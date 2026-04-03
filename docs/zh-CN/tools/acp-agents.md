---
summary: "通过 ACP 运行时会话使用 Codex、Claude Code、Cursor、Gemini CLI、OpenClaw ACP 和其他 harness 代理"
read_when:
  - 通过 ACP 运行编码 harness
  - 在消息频道上设置会话绑定的 ACP 会话
  - 将消息频道对话绑定到持久 ACP 会话
  - 排查 ACP 后端和插件连接问题
  - 从聊天中操作 /acp 命令
title: "ACP Agents"
---

# ACP agents

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 会话让 OpenClaw 通过 ACP 后端插件运行外部编码 harness（例如 Pi、Claude Code、Codex、Cursor、Copilot、OpenClaw ACP、OpenCode、Gemini CLI 和其他支持的 ACPX harness）。

如果您用通俗语言要求 OpenClaw“在 Codex 中运行这个”或“在线程中启动 Claude Code”，OpenClaw 应该将请求路由到 ACP 运行时（而不是原生子代理运行时）。

如果您想让 Codex 或 Claude Code 作为外部 MCP 客户端直接连接到现有 OpenClaw 频道对话，请改用 [`openclaw mcp serve`](/cli/mcp)。

## 快速操作流程

在您想要实用的 `/acp` 运行手册时使用：

1. 生成会话：
   - `/acp spawn codex --bind here`
   - `/acp spawn codex --mode persistent --thread auto`
2. 在绑定对话或线程中工作（或明确针对该会话密钥）。
3. 检查运行时状态：
   - `/acp status`
4. 根据需要调整运行时选项：
   - `/acp model <provider/model>`
   - `/acp permissions <profile>`
   - `/acp timeout <seconds>`
5. 推动活跃会话而不替换上下文：
   - `/acp steer tighten logging and continue`
6. 停止工作：
   - `/acp cancel`（停止当前轮次），或
   - `/acp close`（关闭会话 + 移除绑定）

## 人类快速开始

自然请求示例：

- “将此 Discord 频道绑定到 Codex。”
- “在此处启动持久 Codex 会话并保持专注。”
- “作为一次性 Claude Code ACP 会话运行此任务并总结结果。”
- “将此 iMessage 聊天绑定到 Codex，并在同一工作区中继续跟进。”
- “在此任务中使用 Gemini CLI，在线程中进行，然后在该同一线程中继续跟进。”

OpenClaw 应该做什么：

1. 选择 `runtime: "acp"`。
2. 解析请求的 harness 目标（`agentId`，例如 `codex`）。
3. 如果请求了当前对话绑定且活跃频道支持，则将 ACP 会话绑定到该对话。
4. 否则，如果请求了线程绑定且当前频道支持，则将 ACP 会话绑定到线程。
5. 将后续绑定消息路由到同一 ACP 会话，直到取消焦点/关闭/过期。

## ACP 与子代理

当您想要外部 harness 运行时使用 ACP。当您想要 OpenClaw 原生委托运行时使用子代理。

| 区域 | ACP 会话 | 子代理运行 |
| ------------- | ------------------------------------- | ---------------------------------- |
| 运行时 | ACP 后端插件（例如 acpx）| OpenClaw 原生子代理运行时 |
| 会话密钥 | `agent:<agentId>:acp:<uuid>` | `agent:<agentId>:subagent:<uuid>` |
| 主要命令 | `/acp ...` | `/subagents ...` |
| 生成工具 | `sessions_spawn` 与 `runtime:"acp"` | `sessions_spawn`（默认运行时）|

另请参阅 [子代理](/tools/subagents)。

## 绑定会话

### 当前对话绑定

当您希望当前对话成为持久 ACP 工作区而不创建子线程时，使用 `/acp spawn <harness> --bind here`。

行为：

- OpenClaw 保持对频道传输、认证、安全和传递的所有权。
- 当前对话被固定到生成的 ACP 会话密钥。
- 该对话中的后续消息路由到同一 ACP 会话。
- `/new` 和 `/reset` 在原地重置同一绑定 ACP 会话。
- `/acp close` 关闭会话并移除当前对话绑定。

实际意味着：

- `--bind here` 保持相同的聊天界面。在 Discord 上，当前频道保持为当前频道。
- `--bind here` 在您生成新工作时仍可以创建新的 ACP 会话。绑定将该会话附加到当前对话。
- `--bind here` 本身不会创建子 Discord 线程或 Telegram 话题。
- ACP 运行时仍可以有自己的工作目录（`cwd`）或后端管理的工作区。那种运行时工作区与聊天界面分开，不会产生新的消息线程。

心智模型：

- 聊天界面：人们继续交谈的地方（`Discord 频道`、`Telegram 话题`、`iMessage 聊天`）
- ACP 会话：OpenClaw 路由到的持久 Codex/Claude/Gemini 运行时状态
- 子线程/话题：仅由 `--thread ...` 创建的可选额外消息界面
- 运行时工作区：harness 运行的文件系统位置（`cwd`、repo 检出、后端工作区）

示例：

- `/acp spawn codex --bind here`：保持此聊天，生成或附加 Codex ACP 会话，并将未来消息路由到这里
- `/acp spawn codex --thread auto`：OpenClaw 可能创建子线程/话题并将 ACP 会话绑定在那里
- `/acp spawn codex --bind here --cwd /workspace/repo`：与上述相同的聊天绑定，但 Codex 在 `/workspace/repo` 中运行

当前对话绑定支持：

- 通过共享对话绑定路径宣传当前对话绑定支持的聊天/消息频道可以通过 `--bind here` 使用。
- 具有自定义线程/话题语义的频道仍可以在相同共享接口后面提供特定于频道的规范化。
- `--bind here` 始终意味着“在原地绑定当前对话”。
- 通用当前对话绑定使用共享 OpenClaw 绑定存储并在正常 Gateway 重启后存活。

备注：

- `--bind here` 和 `--thread ...` 在 `/acp spawn` 上互斥。
- 在 Discord 上，`--bind here` 在原地绑定当前频道或线程。仅当 OpenClaw 需要为 `--thread auto|here` 创建子线程时，才需要 `spawnAcpSessions`。
- 如果活跃频道不暴露当前对话 ACP 绑定，OpenClaw 返回清晰的不支持消息。
- `resume` 和“新会话”问题是 ACP 会话问题，不是频道问题。您可以重用或替换运行时状态而不更改当前聊天界面。

### 线程绑定会话

当频道适配器启用线程绑定时，ACP 会话可以绑定到线程：

- OpenClaw 将线程绑定到目标 ACP 会话。
- 该线程中的后续消息路由到绑定 ACP 会话。
- ACP 输出传递回同一线程。
- 取消焦点/关闭/归档/空闲超时或最大年龄到期会移除绑定。

线程绑定支持是特定于适配器的。如果活跃频道适配器不支持线程绑定，OpenClaw 返回清晰的不支持/不可用消息。

线程绑定 ACP 所需的特性标志：

- `acp.enabled=true`
- `acp.dispatch.enabled` 默认开启（设置 `false` 暂停 ACP 分派）
- 频道适配器 ACP 线程生成标志启用（特定于适配器）
  - Discord：`channels.discord.threadBindings.spawnAcpSessions=true`
  - Telegram：`channels.telegram.threadBindings.spawnAcpSessions=true`

### 支持线程的频道

- 暴露会话/线程绑定能力的任何频道适配器。
- 当前内置支持：
  - Discord 线程/频道
  - Telegram 话题（群组/超级群组中的论坛话题和 DM 话题）
- 插件频道可以通过相同绑定接口添加支持。

## 频道特定设置

对于非临时工作流，在顶级 `bindings[]` 条目中配置持久 ACP 绑定。

### 绑定模型

- `bindings[].type="acp"` 标记持久 ACP 对话绑定。
- `bindings[].match` 识别目标对话：
  - Discord 频道或线程：`match.channel="discord"` + `match.peer.id="<channelOrThreadId>"`
  - Telegram 论坛话题：`match.channel="telegram"` + `match.peer.id="<chatId>:topic:<topicId>"`
  - BlueBubbles DM/群聊：`match.channel="bluebubbles"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`
    为稳定的群组绑定首选 `chat_id:*` 或 `chat_identifier:*`。
  - iMessage DM/群聊：`match.channel="imessage"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`
    为稳定的群组绑定首选 `chat_id:*`。
- `bindings[].agentId` 是所属 OpenClaw 代理 id。
- 可选的 ACP 覆盖位于 `bindings[].acp` 下：
  - `mode`（`persistent` 或 `oneshot`）
  - `label`
  - `cwd`
  - `backend`

### 每个代理的运行时默认值

使用 `agents.list[].runtime` 一次为每个代理定义 ACP 默认值：

- `agents.list[].runtime.type="acp"`
- `agents.list[].runtime.acp.agent`（harness id，例如 `codex` 或 `claude`）
- `agents.list[].runtime.acp.backend`
- `agents.list[].runtime.acp.mode`
- `agents.list[].runtime.acp.cwd`

ACP 绑定会话的覆盖优先级：

1. `bindings[].acp.*`
2. `agents.list[].runtime.acp.*`
3. 全局 ACP 默认值（例如 `acp.backend`）

## 开始 ACP 会话（接口）

### 从 `sessions_spawn`

使用 `runtime: "acp"` 从代理轮次或工具调用启动 ACP 会话。

### 从 `/acp` 命令

根据需要从聊天中使用 `/acp spawn` 进行明确的操作员控制。

## acpx harness 支持（当前）

当前 acpx 内置 harness 别名：

- `claude`
- `codex`
- `copilot`
- `cursor`
- `droid`
- `gemini`
- `iflow`
- `kilocode`
- `kimi`
- `kiro`
- `openclaw`
- `opencode`
- `pi`
- `qwen`

## 权限配置

ACP 会话非交互运行 — 没有 TTY 来批准或拒绝文件写入和 shell 执行权限提示。acpx 插件提供两个配置键来控制 harness 代理如何处理权限。

## 故障排除

| 症状 | 可能原因 | 修复 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACP runtime backend is not configured` | 后端插件缺失或禁用。| 安装并启用后端插件，然后运行 `/acp doctor`。|
| `ACP is disabled by policy` | ACP 全局禁用。| 设置 `acp.enabled=true`。|
| `ACP agent "<id>" is not allowed by policy` | 代理不在允许列表中。| 使用允许的 `agentId` 或更新 `acp.allowedAgents`。|
| `Unable to resolve session target` | 错误的 key/id/label 令牌。| 运行 `/acp sessions`，复制准确的 key/label，重试。|
| `Sandboxed sessions cannot spawn ACP sessions` | ACP 运行时是主机端；请求会话被沙箱化。| 从沙箱化会话使用 `runtime="subagent"`，或从非沙箱化会话运行 ACP 生成。|
| `AcpRuntimeError: Permission prompt unavailable` | `permissionMode` 在非交互 ACP 会话中阻止写入/执行。| 设置 `plugins.entries.acpx.config.permissionMode` 为 `approve-all` 并重启 Gateway。|