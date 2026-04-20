---
summary: "使用 ACP 运行时会话进行 Codex、Claude Code、Cursor、Gemini CLI、OpenClaw ACP 和其他 harness 代理"
read_when:
  - 通过 ACP 运行编码 harness
  - 在消息通道上设置会话绑定的 ACP 会话
  - 将消息通道会话绑定到持久 ACP 会话
  - 排查 ACP 后端和插件连接问题
  - 从聊天中操作 /acp 命令
title: "ACP 代理"
---

# ACP 代理

[代理客户端协议 (ACP)](https://agentclientprotocol.com/) 会话允许 OpenClaw 通过 ACP 后端插件运行外部编码 harness（例如 Pi、Claude Code、Codex、Cursor、Copilot、OpenClaw ACP、OpenCode、Gemini CLI 和其他支持的 ACPX harness）。

如果你用普通语言要求 OpenClaw "在 Codex 中运行这个" 或 "在一个线程中启动 Claude Code"，OpenClaw 应该将该请求路由到 ACP 运行时（而不是原生子代理运行时）。每个 ACP 会话的生成都作为 [后台任务](/automation/tasks) 进行跟踪。

如果你希望 Codex 或 Claude Code 作为外部 MCP 客户端直接连接到现有的 OpenClaw 通道会话，请使用 [`openclaw mcp serve`](/cli/mcp) 而不是 ACP。

## 我需要哪个页面？

有三个邻近的界面容易混淆：

| 你想要...                                                                     | 使用这个                              | 说明                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 通过 OpenClaw 运行 Codex、Claude Code、Gemini CLI 或其他外部 harness             | 本页面：ACP 代理                 | 聊天绑定会话、`/acp spawn`、`sessions_spawn({ runtime: "acp" })`、后台任务、运行时控制 |
| 将 OpenClaw Gateway 会话作为 ACP 服务器暴露给编辑器或客户端                        | [`openclaw acp`](/cli/acp)            | 桥接模式。IDE/客户端通过 stdio/WebSocket 与 OpenClaw 进行 ACP 通信                                          |
| 重用本地 AI CLI 作为纯文本回退模型                                               | [CLI 后端](/gateway/cli-backends) | 非 ACP。无 OpenClaw 工具，无 ACP 控制，无 harness 运行时                                             |

## 这开箱即用吗？

通常是的。

- 新安装现在默认启用捆绑的 `acpx` 运行时插件。
- 捆绑的 `acpx` 插件优先使用其插件本地固定的 `acpx` 二进制文件。
- 启动时，OpenClaw 会探测该二进制文件并在需要时自动修复。
- 如果你想要快速就绪检查，从 `/acp doctor` 开始。

首次使用时可能发生的情况：

- 目标 harness 适配器可能会在你第一次使用该 harness 时通过 `npx` 按需获取。
- 该 harness 的供应商认证仍然必须存在于主机上。
- 如果主机没有 npm/网络访问权限，首次运行的适配器获取可能会失败，直到缓存预热或通过其他方式安装适配器。

示例：

- `/acp spawn codex`：OpenClaw 应该准备好引导 `acpx`，但 Codex ACP 适配器可能仍需要首次运行获取。
- `/acp spawn claude`：Claude ACP 适配器的情况相同，加上该主机上的 Claude 端认证。

## 快速操作流程

当你需要实用的 `/acp` 运行手册时使用：

1. 生成会话：
   - `/acp spawn codex --bind here`
   - `/acp spawn codex --mode persistent --thread auto`
2. 在绑定的会话或线程中工作（或显式指定该会话密钥）。
3. 检查运行时状态：
   - `/acp status`
4. 根据需要调整运行时选项：
   - `/acp model <provider/model>`
   - `/acp permissions <profile>`
   - `/acp timeout <seconds>`
5. 轻推活动会话而不替换上下文：
   - `/acp steer tighten logging and continue`
6. 停止工作：
   - `/acp cancel`（停止当前回合），或
   - `/acp close`（关闭会话 + 移除绑定）

## 人类快速入门

自然请求的示例：

- "将此 Discord 频道绑定到 Codex。"
- "在此处的线程中启动持久 Codex 会话并保持专注。"
- "将此作为一次性 Claude Code ACP 会话运行并总结结果。"
- "将此 iMessage 聊天绑定到 Codex 并在同一工作区中保持后续操作。"
- "使用 Gemini CLI 在此线程中执行此任务，然后在同一线程中继续后续操作。"

OpenClaw 应该做什么：

1. 选择 `runtime: "acp"`。
2. 解析请求的 harness 目标（`agentId`，例如 `codex`）。
3. 如果请求了当前会话绑定且活动通道支持，则将 ACP 会话绑定到该会话。
4. 否则，如果请求了线程绑定且当前通道支持，则将 ACP 会话绑定到线程。
5. 直到取消焦点/关闭/过期，才将后续绑定消息路由到同一个 ACP 会话。

## ACP 与子代理

当你想要外部 harness 运行时时使用 ACP。当你想要 OpenClaw 原生委托运行时使用子代理。

| 领域          | ACP 会话                           | 子代理运行                      |
| ------------- | ------------------------------------- | ---------------------------------- |
| 运行时       | ACP 后端插件（例如 acpx） | OpenClaw 原生子代理运行时  |
| 会话密钥   | `agent:<agentId>:acp:<uuid>`          | `agent:<agentId>:subagent:<uuid>`  |
| 主要命令 | `/acp ...`                            | `/subagents ...`                   |
| 生成工具 | `sessions_spawn` 带 `runtime:"acp"` | `sessions_spawn`（默认运行时） |

另请参阅 [子代理](/tools/subagents)。

## ACP 如何运行 Claude Code

对于通过 ACP 的 Claude Code，堆栈是：

1. OpenClaw ACP 会话控制平面
2. 捆绑的 `acpx` 运行时插件
3. Claude ACP 适配器
4. Claude 端运行时/会话机制

重要区别：

- ACP Claude 是一个具有 ACP 控制、会话恢复、后台任务跟踪和可选会话/线程绑定的 harness 会话。
- CLI 后端是单独的纯文本本地回退运行时。请参阅 [CLI 后端](/gateway/cli-backends)。

对于操作员，实用规则是：

- 想要 `/acp spawn`、可绑定会话、运行时控制或持久 harness 工作：使用 ACP
- 想要通过原始 CLI 进行简单的本地文本回退：使用 CLI 后端

## 绑定会话

### 当前会话绑定

当你希望当前会话成为持久 ACP 工作区而不创建子线程时，使用 `/acp spawn <harness> --bind here`。

行为：

- OpenClaw 保持拥有通道传输、认证、安全和交付。
- 当前会话固定到生成的 ACP 会话密钥。
- 该会话中的后续消息路由到同一个 ACP 会话。
- `/new` 和 `/reset` 会在原地重置同一个绑定的 ACP 会话。
- `/acp close` 关闭会话并移除当前会话绑定。

这在实践中意味着：

- `--bind here` 保持相同的聊天界面。在 Discord 上，当前频道保持为当前频道。
- 如果你正在生成新工作，`--bind here` 仍然可以创建新的 ACP 会话。绑定会将该会话附加到当前会话。
- `--bind here` 本身不会创建子 Discord 线程或 Telegram 主题。
- ACP 运行时仍然可以有自己的工作目录（`cwd`）或后端管理的磁盘工作区。该运行时工作区与聊天界面前分离，不意味着新的消息线程。
- 如果你生成到不同的 ACP 代理且未传递 `--cwd`，OpenClaw 默认继承 **目标代理的** 工作区，而不是请求者的。
- 如果该继承的工作区路径缺失（`ENOENT`/`ENOTDIR`），OpenClaw 会回退到后端默认 cwd，而不是静默重用错误的树。
- 如果继承的工作区存在但无法访问（例如 `EACCES`），生成会返回真实的访问错误，而不是丢弃 `cwd`。

心智模型：

- 聊天界面：人们保持交谈的地方（`Discord 频道`、`Telegram 主题`、`iMessage 聊天`）
- ACP 会话：OpenClaw 路由到的持久 Codex/Claude/Gemini 运行时状态
- 子线程/主题：仅由 `--thread ...` 创建的可选额外消息界面
- 运行时工作区：harness 运行的文件系统位置（`cwd`、仓库检出、后端工作区）

示例：

- `/acp spawn codex --bind here`：保持此聊天，生成或附加 Codex ACP 会话，并将未来的消息路由到它
- `/acp spawn codex --thread auto`：OpenClaw 可能创建子线程/主题并在那里绑定 ACP 会话
- `/acp spawn codex --bind here --cwd /workspace/repo`：与上面相同的聊天绑定，但 Codex 在 `/workspace/repo` 中运行

当前会话绑定支持：

- 宣传当前会话绑定支持的聊天/消息通道可以通过共享的会话绑定路径使用 `--bind here`。
- 具有自定义线程/主题语义的通道仍然可以在同一共享接口后面提供通道特定的规范化。
- `--bind here` 始终意味着 "在原地绑定当前会话"。
- 通用当前会话绑定使用共享的 OpenClaw 绑定存储，并在正常的网关重启后仍然存在。

注意：

- `--bind here` 和 `--thread ...` 在 `/acp spawn` 上是互斥的。
- 在 Discord 上，`--bind here` 绑定当前频道或线程。`spawnAcpSessions` 仅在 OpenClaw 需要为 `--thread auto|here` 创建子线程时才需要。
- 如果活动通道不公开当前会话 ACP 绑定，OpenClaw 会返回明确的不支持消息。
- "恢复" 和 "新会话" 问题是 ACP 会话问题，不是通道问题。你可以重用或替换运行时状态而不更改当前聊天界面。

### 线程绑定会话

当线程绑定为通道适配器启用时，ACP 会话可以绑定到线程：

- OpenClaw 将线程绑定到目标 ACP 会话。
- 该线程中的后续消息路由到绑定的 ACP 会话。
- ACP 输出被传递回同一线程。
- 取消焦点/关闭/归档/空闲超时或最大年龄过期会移除绑定。

线程绑定支持是适配器特定的。如果活动通道适配器不支持线程绑定，OpenClaw 会返回明确的不支持/不可用消息。

线程绑定 ACP 的必需功能标志：

- `acp.enabled=true`
- `acp.dispatch.enabled` 默认开启（设置为 `false` 以暂停 ACP 调度）
- 通道适配器 ACP 线程生成标志已启用（适配器特定）
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
  - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`

### 支持线程的通道

- 任何暴露会话/线程绑定能力的通道适配器。
- 当前内置支持：
  - Discord 线程/频道
  - Telegram 主题（群组/超级群组中的论坛主题和 DM 主题）
- 插件通道可以通过相同的绑定接口添加支持。

## 通道特定设置

对于非临时工作流，在顶级 `bindings[]` 条目中配置持久 ACP 绑定。

### 绑定模型

- `bindings[].type="acp"` 标记持久 ACP 会话绑定。
- `bindings[].match` 标识目标会话：
  - Discord 频道或线程：`match.channel="discord"` + `match.peer.id="<channelOrThreadId>"`
  - Telegram 论坛主题：`match.channel="telegram"` + `match.peer.id="<chatId>:topic:<topicId>"`
  - BlueBubbles DM/群聊：`match.channel="bluebubbles"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`
    对于稳定的群组绑定，首选 `chat_id:*` 或 `chat_identifier:*`。
  - iMessage DM/群聊：`match.channel="imessage"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`
    对于稳定的群组绑定，首选 `chat_id:*`。
- `bindings[].agentId` 是拥有的 OpenClaw 代理 ID。
- 可选的 ACP 覆盖位于 `bindings[].acp` 下：
  - `mode`（`persistent` 或 `oneshot`）
  - `label`
  - `cwd`
  - `backend`

### 每个代理的运行时默认值

使用 `agents.list[].runtime` 为每个代理定义一次 ACP 默认值：

- `agents.list[].runtime.type="acp"`
- `agents.list[].runtime.acp.agent`（harness ID，例如 `codex` 或 `claude`）
- `agents.list[].runtime.acp.backend`
- `agents.list[].runtime.acp.mode`
- `agents.list[].runtime.acp.cwd`

ACP 绑定会话的覆盖优先级：

1. `bindings[].acp.*`
2. `agents.list[].runtime.acp.*`
3. 全局 ACP 默认值（例如 `acp.backend`）

示例：

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
      {
        id: "claude",
        runtime: {
          type: "acp",
          acp: { agent: "claude", backend: "acpx", mode: "persistent" },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
    {
      type: "acp",
      agentId: "claude",
      match: {
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-1001234567890:topic:42" },
      },
      acp: { cwd: "/workspace/repo-b" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "discord", accountId: "default" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "telegram", accountId: "default" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": { requireMention: false },
          },
        },
      },
    },
    telegram: {
      groups: {
        "-1001234567890": {
          topics: { "42": { requireMention: false } },
        },
      },
    },
  },
}
```

行为：

- OpenClaw 确保配置的 ACP 会话在使用前存在。
- 该频道或主题中的消息路由到配置的 ACP 会话。
- 在绑定的会话中，`/new` 和 `/reset` 会在原地重置同一个 ACP 会话密钥。
- 临时运行时绑定（例如由线程焦点流程创建）仍然在存在的地方应用。
- 对于没有显式 `cwd` 的跨代理 ACP 生成，OpenClaw 从代理配置继承目标代理工作区。
- 缺失的继承工作区路径回退到后端默认 cwd；非缺失的访问失败会作为生成错误出现。

## 启动 ACP 会话（接口）

### 从 `sessions_spawn`

使用 `runtime: "acp"` 从代理回合或工具调用启动 ACP 会话。

```json
{
  "task": "打开仓库并总结失败的测试",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

注意：

- `runtime` 默认值为 `subagent`，因此对于 ACP 会话，明确设置 `runtime: "acp"`。
- 如果省略 `agentId`，OpenClaw 在配置时使用 `acp.defaultAgent`。
- `mode: "session"` 需要 `thread: true` 来保持持久绑定的会话。

接口详情：

- `task`（必需）：发送到 ACP 会话的初始提示。
- `runtime`（ACP 必需）：必须为 `"acp"`。
- `agentId`（可选）：ACP 目标 harness ID。如果设置，回退到 `acp.defaultAgent`。
- `thread`（可选，默认 `false`）：在支持的地方请求线程绑定流程。
- `mode`（可选）：`run`（一次性）或 `session`（持久）。
  - 默认值为 `run`
  - 如果 `thread: true` 且省略 mode，OpenClaw 可能根据运行时路径默认为持久行为
  - `mode: "session"` 需要 `thread: true`
- `cwd`（可选）：请求的运行时工作目录（由后端/运行时策略验证）。如果省略，ACP 生成在配置时继承目标代理工作区；缺失的继承路径回退到后端默认值，而真实的访问错误会被返回。
- `label`（可选）：在会话/横幅文本中使用的面向操作员的标签。
- `resumeSessionId`（可选）：恢复现有 ACP 会话而不是创建新会话。代理通过 `session/load` 重放其会话历史。需要 `runtime: "acp"`。
- `streamTo`（可选）：`"parent"` 将初始 ACP 运行进度摘要作为系统事件流回请求者会话。
  - 当可用时，接受的响应包括 `streamLogPath`，指向会话范围的 JSONL 日志（`<sessionId>.acp-stream.jsonl`），你可以尾随完整的中继历史。

### 恢复现有会话

使用 `resumeSessionId` 继续之前的 ACP 会话而不是重新开始。代理通过 `session/load` 重放其会话历史，因此它会带着之前所有内容的完整上下文继续。

```json
{
  "task": "继续我们离开的地方 — 修复剩余的测试失败",
  "runtime": "acp",
  "agentId": "codex",
  "resumeSessionId": "<previous-session-id>"
}
```

常见用例：

- 将 Codex 会话从笔记本电脑切换到手机 — 告诉你的代理从你离开的地方继续
- 继续你在 CLI 中交互式开始的编码会话，现在通过你的代理无头运行
- 继续因网关重启或空闲超时而中断的工作

注意：

- `resumeSessionId` 需要 `runtime: "acp"` — 如果与子代理运行时一起使用，会返回错误。
- `resumeSessionId` 恢复上游 ACP 会话历史；`thread` 和 `mode` 仍然正常应用于你正在创建的新 OpenClaw 会话，因此 `mode: "session"` 仍然需要 `thread: true`。
- 目标代理必须支持 `session/load`（Codex 和 Claude Code 支持）。
- 如果找不到会话 ID，生成会失败并显示明确的错误 — 不会静默回退到新会话。

### 操作员冒烟测试

当你想要快速实时检查 ACP 生成实际上端到端工作，而不仅仅是通过单元测试时，在网关部署后使用此测试。

推荐的检查：

1. 验证目标主机上部署的网关版本/提交。
2. 确认部署的源代码在
   `src/gateway/sessions-patch.ts` 中包含 ACP 谱系接受（`subagent:* or acp:* sessions`）。
3. 打开临时 ACPX 桥接会话到实时代理（例如
   `jpclawhq` 上的 `razor(main)`）。
4. 要求该代理调用 `sessions_spawn`，带有：
   - `runtime: "acp"`
   - `agentId: "codex"`
   - `mode: "run"`
   - 任务：`Reply with exactly LIVE-ACP-SPAWN-OK`
5. 验证代理报告：
   - `accepted=yes`
   - 真实的 `childSessionKey`
   - 无验证器错误
6. 清理临时 ACPX 桥接会话。

给实时代理的示例提示：

```text
现在使用 sessions_spawn 工具，runtime: "acp"，agentId: "codex"，mode: "run"。
将任务设置为："Reply with exactly LIVE-ACP-SPAWN-OK"。
然后只报告：accepted=<yes/no>; childSessionKey=<value or none>; error=<exact text or none>。
```

注意：

- 保持此冒烟测试为 `mode: "run"`，除非你有意测试线程绑定的持久 ACP 会话。
- 不要为基本检查要求 `streamTo: "parent"`。该路径依赖于请求者/会话功能，是单独的集成检查。
- 将线程绑定的 `mode: "session"` 测试视为来自真实 Discord 线程或 Telegram 主题的第二次更丰富的集成传递。

## 沙箱兼容性

ACP 会话目前在主机运行时上运行，而不是在 OpenClaw 沙箱内。

当前限制：

- 如果请求者会话被沙箱化，`sessions_spawn({ runtime: "acp" })` 和 `/acp spawn` 的 ACP 生成都会被阻止。
  - 错误：`Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.`
- `sessions_spawn` 与 `runtime: "acp"` 不支持 `sandbox: "require"`。
  - 错误：`sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".`

当你需要沙箱强制执行时，使用 `runtime: "subagent"`。

### 从 `/acp` 命令

当需要时，使用 `/acp spawn` 从聊天中进行显式操作员控制。

```text
/acp spawn codex --mode persistent --thread auto
/acp spawn codex --mode oneshot --thread off
/acp spawn codex --bind here
/acp spawn codex --thread here
```

关键标志：

- `--mode persistent|oneshot`
- `--bind here|off`
- `--thread auto|here|off`
- `--cwd <absolute-path>`
- `--label <name>`

请参阅 [斜杠命令](/tools/slash-commands)。

## 会话目标解析

大多数 `/acp` 操作接受可选的会话目标（`session-key`、`session-id` 或 `session-label`）。

解析顺序：

1. 显式目标参数（或 `/acp steer` 的 `--session`）
   - 尝试密钥
   - 然后是 UUID 形状的会话 ID
   - 然后是标签
2. 当前线程绑定（如果此会话/线程绑定到 ACP 会话）
3. 当前请求者会话回退

当前会话绑定和线程绑定都参与步骤 2。

如果没有目标解析，OpenClaw 会返回明确的错误（`Unable to resolve session target: ...`）。

## 生成绑定模式

`/acp spawn` 支持 `--bind here|off`。

| 模式   | 行为                                                               |
| ------ | ---------------------------------------------------------------------- |
| `here` | 原地绑定当前活动会话；如果没有活动会话则失败。 |
| `off`  | 不创建当前会话绑定。                          |

注意：

- `--bind here` 是 "使此频道或聊天成为 Codex 支持" 的最简单操作员路径。
- `--bind here` 不创建子线程。
- `--bind here` 仅在公开当前会话绑定支持的频道上可用。
- `--bind` 和 `--thread` 不能在同一个 `/acp spawn` 调用中组合。

## 生成线程模式

`/acp spawn` 支持 `--thread auto|here|off`。

| 模式   | 行为                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------- |
| `auto` | 在活动线程中：绑定该线程。在线程外：在支持时创建/绑定子线程。 |
| `here` | 需要当前活动线程；如果不在线程中则失败。                                                  |
| `off`  | 无绑定。会话开始时未绑定。                                                                 |

注意：

- 在非线程绑定界面上，默认行为实际上是 `off`。
- 线程绑定生成需要通道策略支持：
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
  - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`
- 当你想要固定当前会话而不创建子线程时，使用 `--bind here`。

## ACP 控制

可用命令系列：

- `/acp spawn`
- `/acp cancel`
- `/acp steer`
- `/acp close`
- `/acp status`
- `/acp set-mode`
- `/acp set`
- `/acp cwd`
- `/acp permissions`
- `/acp timeout`
- `/acp model`
- `/acp reset-options`
- `/acp sessions`
- `/acp doctor`
- `/acp install`

`/acp status` 显示有效运行时选项，以及（当可用时）运行时级别和后端级别会话标识符。

一些控件依赖于后端功能。如果后端不支持控件，OpenClaw 会返回明确的不支持控件错误。

## ACP 命令手册

| 命令              | 作用                                              | 示例                                                       |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `/acp spawn`         | 创建 ACP 会话；可选当前绑定或线程绑定。 | `/acp spawn codex --bind here --cwd /repo`                    |
| `/acp cancel`        | 取消目标会话的进行中回合。                 | `/acp cancel agent:codex:acp:<uuid>`                          |
| `/acp steer`         | 向运行中的会话发送引导指令。                | `/acp steer --session support inbox prioritize failing tests` |
| `/acp close`         | 关闭会话并解绑线程目标。                  | `/acp close`                                                  |
| `/acp status`        | 显示后端、模式、状态、运行时选项、功能。 | `/acp status`                                                 |
| `/acp set-mode`      | 为目标会话设置运行时模式。                      | `/acp set-mode plan`                                          |
| `/acp set`           | 通用运行时配置选项写入。                      | `/acp set model openai/gpt-5.4`                               |
| `/acp cwd`           | 设置运行时工作目录覆盖。                   | `/acp cwd /Users/user/Projects/repo`                          |
| `/acp permissions`   | 设置批准策略配置文件。                              | `/acp permissions strict`                                     |
| `/acp timeout`       | 设置运行时超时（秒）。                            | `/acp timeout 120`                                            |
| `/acp model`         | 设置运行时模型覆盖。                               | `/acp model anthropic/claude-opus-4-6`                        |
| `/acp reset-options` | 移除会话运行时选项覆盖。                  | `/acp reset-options`                                          |
| `/acp sessions`      | 从存储中列出最近的 ACP 会话。                      | `/acp sessions`                                               |
| `/acp doctor`        | 后端健康、功能、可操作修复。           | `/acp doctor`                                                 |
| `/acp install`       | 打印确定性安装和启用步骤。             | `/acp install`                                                |

`/acp sessions` 读取当前绑定或请求者会话的存储。接受 `session-key`、`session-id` 或 `session-label` 令牌的命令通过网关会话发现解析目标，包括自定义的每个代理 `session.store` 根。

## 运行时选项映射

`/acp` 有便利命令和通用设置器。

等效操作：

- `/acp model <id>` 映射到运行时配置键 `model`。
- `/acp permissions <profile>` 映射到运行时配置键 `approval_policy`。
- `/acp timeout <seconds>` 映射到运行时配置键 `timeout`。
- `/acp cwd <path>` 直接更新运行时 cwd 覆盖。
- `/acp set <key> <value>` 是通用路径。
  - 特殊情况：`key=cwd` 使用 cwd 覆盖路径。
- `/acp reset-options` 清除目标会话的所有运行时覆盖。

## acpx harness 支持（当前）

当前 acpx 内置 harness 别名：

- `claude`
- `codex`
- `copilot`
- `cursor`（Cursor CLI: `cursor-agent acp`）
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

当 OpenClaw 使用 acpx 后端时，除非你的 acpx 配置定义了自定义代理别名，否则首选这些值作为 `agentId`。
如果你的本地 Cursor 安装仍然将 ACP 暴露为 `agent acp`，请在你的 acpx 配置中覆盖 `cursor` 代理命令，而不是更改内置默认值。

直接的 acpx CLI 使用也可以通过 `--agent <command>` 目标任意适配器，但该原始逃生舱口是 acpx CLI 功能（不是正常的 OpenClaw `agentId` 路径）。

## 必需配置

核心 ACP 基线：

```json5
{
  acp: {
    enabled: true,
    // 可选。默认值为 true；设置为 false 以暂停 ACP 调度，同时保持 /acp 控制。
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "droid",
      "gemini",
      "iflow",
      "kilocode",
      "kimi",
      "kiro",
      "openclaw",
      "opencode",
      "pi",
      "qwen",
    ],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
    runtime: {
      ttlMinutes: 120,
    },
  },
}
```

线程绑定配置是通道适配器特定的。Discord 示例：

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
}
```

如果线程绑定 ACP 生成不工作，请首先验证适配器功能标志：

- Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

当前会话绑定不需要创建子线程。它们需要活动会话上下文和暴露 ACP 会话绑定的通道适配器。

请参阅 [配置参考](/gateway/configuration-reference)。

## acpx 后端的插件设置

新安装默认启用捆绑的 `acpx` 运行时插件，因此 ACP 通常无需手动插件安装步骤即可工作。

从以下开始：

```text
/acp doctor
```

如果你禁用了 `acpx`、通过 `plugins.allow` / `plugins.deny` 拒绝了它，或想要切换到本地开发检出，请使用显式插件路径：

```bash
openclaw plugins install acpx
openclaw config set plugins.entries.acpx.enabled true
```

开发期间的本地工作区安装：

```bash
openclaw plugins install ./path/to/local/acpx-plugin
```

然后验证后端健康：

```text
/acp doctor
```

### acpx 命令和版本配置

默认情况下，捆绑的 acpx 后端插件 (`acpx`) 使用插件本地固定的二进制文件：

1. 命令默认为 ACPX 插件包内的插件本地 `node_modules/.bin/acpx`。
2. 预期版本默认为扩展固定值。
3. 启动时立即将 ACP 后端注册为未就绪。
4. 后台确保作业验证 `acpx --version`。
5. 如果插件本地二进制文件缺失或不匹配，它会运行：
   `npm install --omit=dev --no-save acpx@<pinned>` 并重新验证。

你可以在插件配置中覆盖命令/版本：

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "command": "../acpx/dist/cli.js",
          "expectedVersion": "any"
        }
      }
    }
  }
}
```

注意：

- `command` 接受绝对路径、相对路径或命令名称 (`acpx`)。
- 相对路径从 OpenClaw 工作区目录解析。
- `expectedVersion: "any"` 禁用严格版本匹配。
- 当 `command` 指向自定义二进制文件/路径时，插件本地自动安装被禁用。
- 当后端健康检查运行时，OpenClaw 启动保持非阻塞。

请参阅 [插件](/tools/plugin)。

### 自动依赖安装

当你使用 `npm install -g openclaw` 全局安装 OpenClaw 时，acpx 运行时依赖项（平台特定二进制文件）通过 postinstall 钩子自动安装。如果自动安装失败，网关仍会正常启动并通过 `openclaw acp doctor` 报告缺失的依赖项。

### 插件工具 MCP 桥

默认情况下，ACPX 会话 **不** 向 ACP harness 公开 OpenClaw 插件注册的工具。

如果你希望 ACP 代理（如 Codex 或 Claude Code）调用已安装的 OpenClaw 插件工具（如内存召回/存储），请启用专用桥：

```bash
openclaw config set plugins.entries.acpx.config.pluginToolsMcpBridge true
```

这会做什么：

- 将名为 `openclaw-plugin-tools` 的内置 MCP 服务器注入 ACPX 会话引导。
- 暴露已由已安装和启用的 OpenClaw 插件注册的插件工具。
- 保持该功能显式且默认关闭。

安全和信任注意事项：

- 这会扩展 ACP harness 工具表面。
- ACP 代理只能访问网关中已激活的插件工具。
- 将此视为与让这些插件在 OpenClaw 本身中执行相同的信任边界。
- 在启用之前审查已安装的插件。

自定义 `mcpServers` 仍然像以前一样工作。内置插件工具桥是额外的可选便利，不是通用 MCP 服务器配置的替代品。

### 运行时超时配置

捆绑的 `acpx` 插件将嵌入式运行时回合默认为 120 秒超时。这为较慢的 harness（如 Gemini CLI）提供足够的时间完成 ACP 启动和初始化。如果你的主机需要不同的运行时限制，请覆盖它：

```bash
openclaw config set plugins.entries.acpx.config.timeoutSeconds 180
```

更改此值后重启网关。

## 权限配置

ACP 会话非交互式运行 — 没有 TTY 来批准或拒绝文件写入和 shell 执行权限提示。acpx 插件提供两个控制权限处理方式的配置键：

这些 ACPX harness 权限与 OpenClaw 执行批准和与 CLI 后端供应商绕过标志（如 Claude CLI `--permission-mode bypassPermissions`）是分开的。ACPX `approve-all` 是 ACP 会话的 harness 级别紧急开关。

### `permissionMode`

控制 harness 代理在没有提示的情况下可以执行哪些操作。

| 值           | 行为                                                  |
| --------------- | --------------------------------------------------------- |
| `approve-all`   | 自动批准所有文件写入和 shell 命令。          |
| `approve-reads` | 仅自动批准读取；写入和执行需要提示。 |
| `deny-all`      | 拒绝所有权限提示。                              |

### `nonInteractivePermissions`

控制当权限提示应该显示但没有交互式 TTY 可用时会发生什么（这对于 ACP 会话始终是这种情况）。

| 值  | 行为                                                          |
| ------ | ----------------------------------------------------------------- |
| `fail` | 以 `AcpRuntimeError` 中止会话。 **（默认）**           |
| `deny` | 静默拒绝权限并继续（优雅降级）。 |

### 配置

通过插件配置设置：

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
```

更改这些值后重启网关。

> **重要：** OpenClaw 当前默认为 `permissionMode=approve-reads` 和 `nonInteractivePermissions=fail`。在非交互式 ACP 会话中，任何触发权限提示的写入或执行都可能以 `AcpRuntimeError: Permission prompt unavailable in non-interactive mode` 失败。
>
> 如果你需要限制权限，将 `nonInteractivePermissions` 设置为 `deny`，以便会话优雅降级而不是崩溃。

## 故障排除

| 症状                                                                     | 可能原因                                                                    | 修复                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACP runtime backend is not configured`                                     | 后端插件缺失或禁用。                                             | 安装并启用后端插件，然后运行 `/acp doctor`。                                                                                                        |
| `ACP is disabled by policy (acp.enabled=false)`                             | ACP 全局禁用。                                                          | 设置 `acp.enabled=true`。                                                                                                                                           |
| `ACP dispatch is disabled by policy (acp.dispatch.enabled=false)`           | 来自普通线程消息的调度禁用。                                  | 设置 `acp.dispatch.enabled=true`。                                                                                                                                  |
| `ACP agent "<id>" is not allowed by policy`                                 | 代理不在允许列表中。                                                         | 使用允许的 `agentId` 或更新 `acp.allowedAgents`。                                                                                                              |
| `Unable to resolve session target: ...`                                     | 错误的键/ID/标签令牌。                                                         | 运行 `/acp sessions`，复制确切的键/标签，重试。                                                                                                                 |
| `--bind here requires running /acp spawn inside an active ... conversation` | `--bind here` 在没有活动的可绑定会话的情况下使用。                     | 移动到目标聊天/频道并重试，或使用未绑定的生成。                                                                                                  |
| `Conversation bindings are unavailable for <channel>.`                      | 适配器缺少当前会话 ACP 绑定能力。                      | 在支持的地方使用 `/acp spawn ... --thread ...`，配置顶级 `bindings[]`，或移动到支持的频道。                                              |
| `--thread here requires running /acp spawn inside an active ... thread`     | `--thread here` 在线程上下文之外使用。                                  | 移动到目标线程或使用 `--thread auto`/`off`。                                                                                                               |
| `Only <user-id> can rebind this channel/conversation/thread.`               | 另一个用户拥有活动绑定目标。                                    | 作为所有者重新绑定或使用不同的会话或线程。                                                                                                        |
| `Thread bindings are unavailable for <channel>.`                            | 适配器缺少线程绑定能力。                                        | 使用 `--thread off` 或移动到支持的适配器/频道。                                                                                                          |
| `Sandboxed sessions cannot spawn ACP sessions ...`                          | ACP 运行时在主机端；请求者会话被沙箱化。                       | 从沙箱化会话使用 `runtime="subagent"`，或从非沙箱化会话运行 ACP 生成。                                                                  |
| `sessions_spawn sandbox="require" is unsupported for runtime="acp" ...`     | 为 ACP 运行时请求 `sandbox="require"`。                                  | 对于必需的沙箱使用 `runtime="subagent"`，或从非沙箱化会话使用带有 `sandbox="inherit"` 的 ACP。                                               |
| 绑定会话缺少 ACP 元数据                                      | 过时/已删除的 ACP 会话元数据。                                             | 使用 `/acp spawn` 重新创建，然后重新绑定/聚焦线程。                                                                                                             |
| `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`    | `permissionMode` 在非交互式 ACP 会话中阻止写入/执行。             | 将 `plugins.entries.acpx.config.permissionMode` 设置为 `approve-all` 并重启网关。请参阅 [权限配置](#permission-configuration)。                 |
| ACP 会话早期失败，几乎没有输出                                  | 权限提示被 `permissionMode`/`nonInteractivePermissions` 阻止。 | 检查网关日志中的 `AcpRuntimeError`。对于完全权限，设置 `permissionMode=approve-all`；对于优雅降级，设置 `nonInteractivePermissions=deny`。 |
| ACP 会话在完成工作后无限期停滞                       | Harness 进程已完成但 ACP 会话未报告完成。             | 使用 `ps aux \| grep acpx` 监控；手动终止过时进程。                                                                                                |