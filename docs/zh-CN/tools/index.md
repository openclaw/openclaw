---
read_when:
  - 添加或修改智能体工具
  - 停用或更改 `openclaw-*` Skills
summary: OpenClaw 的智能体工具接口（browser、canvas、nodes、message、cron），替代旧版 `openclaw-*` Skills
title: 工具
x-i18n:
  generated_at: "2026-02-03T10:12:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a1ec62a9c9bea4c1d2cebfb88509739a3b48b451ab3e378193c620832e2aa07b
  source_path: tools/index.md
  workflow: 15
---

# 工具（OpenClaw）

OpenClaw 为 browser、canvas、nodes 和 cron 暴露**一流的智能体工具**。
这些工具取代了旧的 `openclaw-*` Skills：工具是类型化的，无需调用 shell，
智能体应该直接依赖它们。

## 禁用工具

你可以通过 `openclaw.json` 中的 `tools.allow` / `tools.deny` 全局允许/拒绝工具
（deny 优先）。这会阻止不允许的工具被发送到模型提供商。

```json5
{
  tools: { deny: ["browser"] },
}
```

注意：

- 匹配不区分大小写。
- 支持 `*` 通配符（`"*"` 表示所有工具）。
- 如果 `tools.allow` 仅引用未知或未加载的插件工具名称，OpenClaw 会记录警告并忽略允许列表，以确保核心工具保持可用。

## 工具配置文件（基础允许列表）

`tools.profile` 在 `tools.allow`/`tools.deny` 之前设置**基础工具允许列表**。
按智能体覆盖：`agents.list[].tools.profile`。

配置文件：

- `minimal`：仅 `session_status`
- `coding`：`group:fs`、`group:runtime`、`group:sessions`、`group:memory`、`image`
- `messaging`：`group:messaging`、`sessions_list`、`sessions_history`、`sessions_send`、`session_status`
- `full`：无限制（与未设置相同）

示例（默认仅消息，同时允许 Slack + Discord 工具）：

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

示例（coding 配置文件，但在所有地方拒绝 exec/process）：

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

示例（全局 coding 配置文件，仅消息的支持智能体）：

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## 特定提供商的工具策略

使用 `tools.byProvider` 为特定提供商（或单个 `provider/model`）**进一步限制**工具，
而不更改你的全局默认值。
按智能体覆盖：`agents.list[].tools.byProvider`。

这在基础工具配置文件**之后**和允许/拒绝列表**之前**应用，
因此它只能缩小工具集。
提供商键接受 `provider`（例如 `google-antigravity`）或
`provider/model`（例如 `openai/gpt-5.2`）。

示例（保持全局 coding 配置文件，但 Google Antigravity 使用最小工具）：

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

示例（针对不稳定端点的 provider/model 特定允许列表）：

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

示例（针对单个提供商的智能体特定覆盖）：

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## 工具组（简写）

工具策略（全局、智能体、沙箱）支持 `group:*` 条目，它们会展开为多个工具。
在 `tools.allow` / `tools.deny` 中使用这些。

可用的组：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:web`：`web_search`、`web_fetch`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有内置 OpenClaw 工具（不包括提供商插件）

示例（仅允许文件工具 + browser）：

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 插件 + 工具

插件可以在核心集之外注册**额外的工具**（和 CLI 命令）。
参见[插件](/tools/plugin)了解安装 + 配置，以及 [Skills](/tools/skills) 了解
工具使用指导如何被注入到提示中。一些插件随工具一起提供自己的 Skills
（例如，voice-call 插件）。

可选的插件工具：

- [Lobster](/tools/lobster)：带有可恢复审批的类型化工作流运行时（需要 Gateway 网关主机上的 Lobster CLI）。
- [LLM Task](/tools/llm-task)：用于结构化工作流输出的 JSON-only LLM 步骤（可选 schema 验证）。

## 工具清单

### `apply_patch`

跨一个或多个文件应用结构化补丁。用于多块编辑。
实验性：通过 `tools.exec.applyPatch.enabled` 启用（仅 OpenAI 模型）。

### `exec`

在工作区中运行 shell 命令。

核心参数：

- `command`（必需）
- `yieldMs`（超时后自动后台运行，默认 10000）
- `background`（立即后台运行）
- `timeout`（秒；超过则终止进程，默认 1800）
- `elevated`（布尔值；如果启用/允许提升模式，则在主机上运行；仅在智能体被沙箱隔离时改变行为）
- `host`（`sandbox | gateway | node`）
- `security`（`deny | allowlist | full`）
- `ask`（`off | on-miss | always`）
- `node`（`host=node` 时的节点 id/名称）
- 需要真正的 TTY？设置 `pty: true`。

注意：

- 后台运行时返回带有 `sessionId` 的 `status: "running"`。
- 使用 `process` 来轮询/日志/写入/终止/清除后台会话。
- 如果不允许 `process`，`exec` 会同步运行并忽略 `yieldMs`/`background`。
- `elevated` 受 `tools.elevated` 加上任何 `agents.list[].tools.elevated` 覆盖的门控（两者都必须允许），是 `host=gateway` + `security=full` 的别名。
- `elevated` 仅在智能体被沙箱隔离时改变行为（否则是空操作）。
- `host=node` 可以针对 macOS 配套应用或无头节点主机（`openclaw node run`）。
- Gateway 网关/节点审批和允许列表：[执行审批](/tools/exec-approvals)。

### `process`

管理后台 exec 会话。

核心操作：

- `list`、`poll`、`log`、`write`、`kill`、`clear`、`remove`

注意：

- `poll` 返回新输出，完成时返回退出状态。
- `log` 支持基于行的 `offset`/`limit`（省略 `offset` 以获取最后 N 行）。
- `process` 按智能体作用域；来自其他智能体的会话不可见。

### `web_search`

使用 Brave Search API 搜索网络。

核心参数：

- `query`（必需）
- `count`（1-10；默认来自 `tools.web.search.maxResults`）

注意：

- 需要 Brave API 密钥（推荐：`openclaw configure --section web`，或设置 `BRAVE_API_KEY`）。
- 通过 `tools.web.search.enabled` 启用。
- 响应被缓存（默认 15 分钟）。
- 参见 [Web 工具](/tools/web) 了解设置。

### `web_fetch`

从 URL 获取并提取可读内容（HTML → markdown/text）。

核心参数：

- `url`（必需）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截断长页面）

注意：

- 通过 `tools.web.fetch.enabled` 启用。
- 响应被缓存（默认 15 分钟）。
- 对于 JS 密集型网站，优先使用 browser 工具。
- 参见 [Web 工具](/tools/web) 了解设置。
- 参见 [Firecrawl](/tools/firecrawl) 了解可选的反机器人回退。

### `browser`

控制专用的 OpenClaw 管理的浏览器。

核心操作：

- `status`、`start`、`stop`、`tabs`、`open`、`focus`、`close`
- `snapshot`（aria/ai）
- `screenshot`（返回图像块 + `MEDIA:<path>`）
- `act`（UI 操作：click/type/press/hover/drag/select/fill/resize/wait/evaluate）
- `navigate`、`console`、`pdf`、`upload`、`dialog`

配置文件管理：

- `profiles` — 列出所有浏览器配置文件及其状态
- `create-profile` — 使用自动分配的端口（或 `cdpUrl`）创建新配置文件
- `delete-profile` — 停止浏览器，删除用户数据，从配置中移除（仅本地）
- `reset-profile` — 终止配置文件端口上的孤儿进程（仅本地）

常用参数：

- `profile`（可选；默认为 `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（可选；选择特定的节点 id/名称）
  注意：
- 需要 `browser.enabled=true`（默认为 `true`；设置为 `false` 以禁用）。
- 所有操作接受可选的 `profile` 参数以支持多实例。
- 当省略 `profile` 时，使用 `browser.defaultProfile`（默认为"chrome"）。
- 配置文件名称：仅小写字母数字 + 连字符（最多 64 字符）。
- 端口范围：18800-18899（最多约 100 个配置文件）。
- 远程配置文件仅支持附加（无 start/stop/reset）。
- 如果连接了支持浏览器的节点，工具可能会自动路由到它（除非你固定了 `target`）。
- 安装 Playwright 时 `snapshot` 默认为 `ai`；使用 `aria` 获取无障碍树。
- `snapshot` 还支持角色快照选项（`interactive`、`compact`、`depth`、`selector`），返回像 `e12` 这样的引用。
- `act` 需要来自 `snapshot` 的 `ref`（AI 快照中的数字 `12`，或角色快照中的 `e12`）；对于罕见的 CSS 选择器需求使用 `evaluate`。
- 默认避免 `act` → `wait`；仅在特殊情况下使用（没有可靠的 UI 状态可等待）。
- `upload` 可以选择性地传递 `ref` 以在准备后自动点击。
- `upload` 还支持 `inputRef`（aria 引用）或 `element`（CSS 选择器）以直接设置 `<input type="file">`。

### `canvas`

驱动节点 Canvas（present、eval、snapshot、A2UI）。

核心操作：

- `present`、`hide`、`navigate`、`eval`
- `snapshot`（返回图像块 + `MEDIA:<path>`）
- `a2ui_push`、`a2ui_reset`

注意：

- 底层使用 Gateway 网关 `node.invoke`。
- 如果未提供 `node`，工具会选择默认值（单个连接的节点或本地 mac 节点）。
- A2UI 仅限 v0.8（无 `createSurface`）；CLI 会拒绝 v0.9 JSONL 并显示行错误。
- 快速冒烟测试：`openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`。

### `nodes`

发现和定位配对的节点；发送通知；捕获摄像头/屏幕。

核心操作：

- `status`、`describe`
- `pending`、`approve`、`reject`（配对）
- `notify`（macOS `system.notify`）
- `run`（macOS `system.run`）
- `camera_snap`、`camera_clip`、`screen_record`
- `location_get`

注意：

- 摄像头/屏幕命令需要节点应用在前台。
- 图像返回图像块 + `MEDIA:<path>`。
- 视频返回 `FILE:<path>`（mp4）。
- 位置返回 JSON 负载（lat/lon/accuracy/timestamp）。
- `run` 参数：`command` argv 数组；可选的 `cwd`、`env`（`KEY=VAL`）、`commandTimeoutMs`、`invokeTimeoutMs`、`needsScreenRecording`。

示例（`run`）：

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

使用配置的图像模型分析图像。

核心参数：

- `image`（必需的路径或 URL）
- `prompt`（可选；默认为"Describe the image."）
- `model`（可选覆盖）
- `maxBytesMb`（可选大小上限）

注意：

- 仅在配置了 `agents.defaults.imageModel`（主要或回退）时可用，或者当可以从你的默认模型 + 配置的认证推断出隐式图像模型时（尽力配对）。
- 直接使用图像模型（独立于主聊天模型）。

### `message`

跨 Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 发送消息和渠道操作。

核心操作：

- `send`（文本 + 可选媒体；MS Teams 还支持用于 Adaptive Cards 的 `card`）
- `poll`（WhatsApp/Discord/MS Teams 投票）
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

注意：

- `send` 通过 Gateway 网关路由 WhatsApp；其他渠道直接发送。
- `poll` 对 WhatsApp 和 MS Teams 使用 Gateway 网关；Discord 投票直接发送。
- 当消息工具调用绑定到活动聊天会话时，发送被限制到该会话的目标以避免跨上下文泄露。

### `cron`

管理 Gateway 网关定时任务和唤醒。

核心操作：

- `status`、`list`
- `add`、`update`、`remove`、`run`、`runs`
- `wake`（入队系统事件 + 可选的立即心跳）

注意：

- `add` 期望完整的定时任务对象（与 `cron.add` RPC 相同的 schema）。
- `update` 使用 `{ id, patch }`。

### `gateway`

重启或对运行中的 Gateway 网关进程应用更新（就地）。

核心操作：

- `restart`（授权 + 发送 `SIGUSR1` 进行进程内重启；`openclaw gateway` 就地重启）
- `config.get` / `config.schema`
- `config.apply`（验证 + 写入配置 + 重启 + 唤醒）
- `config.patch`（合并部分更新 + 重启 + 唤醒）
- `update.run`（运行更新 + 重启 + 唤醒）

注意：

- 使用 `delayMs`（默认 2000）以避免中断进行中的回复。
- `restart` 默认禁用；使用 `commands.restart: true` 启用。

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

列出会话，检查转录历史，或发送到另一个会话。

核心参数：

- `sessions_list`：`kinds?`、`limit?`、`activeMinutes?`、`messageLimit?`（0 = 无）
- `sessions_history`：`sessionKey`（或 `sessionId`）、`limit?`、`includeTools?`
- `sessions_send`：`sessionKey`（或 `sessionId`）、`message`、`timeoutSeconds?`（0 = fire-and-forget）
- `sessions_spawn`：`task`、`label?`、`agentId?`、`model?`、`runTimeoutSeconds?`、`cleanup?`
- `session_status`：`sessionKey?`（默认当前；接受 `sessionId`）、`model?`（`default` 清除覆盖）

注意：

- `main` 是规范的私聊键；global/unknown 是隐藏的。
- `messageLimit > 0` 获取每个会话的最后 N 条消息（工具消息被过滤）。
- 当 `timeoutSeconds > 0` 时，`sessions_send` 等待最终完成。
- 递送/宣告发生在完成后，是尽力而为的；`status: "ok"` 确认智能体运行完成，而不是宣告已递送。
- `sessions_spawn` 启动子智能体运行并将宣告回复发送回请求者聊天。
- `sessions_spawn` 是非阻塞的，立即返回 `status: "accepted"`。
- `sessions_send` 运行回复往返乒乓（回复 `REPLY_SKIP` 以停止；最大轮次通过 `session.agentToAgent.maxPingPongTurns`，0-5）。
- 乒乓之后，目标智能体运行一个**宣告步骤**；回复 `ANNOUNCE_SKIP` 以抑制宣告。

### `agents_list`

列出当前会话可以用 `sessions_spawn` 定位的智能体 id。

注意：

- 结果受每智能体允许列表限制（`agents.list[].subagents.allowAgents`）。
- 当配置为 `["*"]` 时，工具包含所有已配置的智能体并标记 `allowAny: true`。

## 参数（通用）

Gateway 网关支持的工具（`canvas`、`nodes`、`cron`）：

- `gatewayUrl`（默认 `ws://127.0.0.1:18789`）
- `gatewayToken`（如果启用了认证）
- `timeoutMs`

Browser 工具：

- `profile`（可选；默认为 `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（可选；固定特定的节点 id/名称）

## 推荐的智能体流程

浏览器自动化：

1. `browser` → `status` / `start`
2. `snapshot`（ai 或 aria）
3. `act`（click/type/press）
4. `screenshot` 如果你需要视觉确认

Canvas 渲染：

1. `canvas` → `present`
2. `a2ui_push`（可选）
3. `snapshot`

节点定位：

1. `nodes` → `status`
2. 在选定的节点上 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 安全性

- 避免直接 `system.run`；仅在用户明确同意时使用 `nodes` → `run`。
- 尊重用户对摄像头/屏幕捕获的同意。
- 在调用媒体命令前使用 `status/describe` 确保权限。

## 工具如何呈现给智能体

工具通过两个并行渠道暴露：

1. **系统提示文本**：人类可读的列表 + 指导。
2. **工具 schema**：发送到模型 API 的结构化函数定义。

这意味着智能体同时看到"存在哪些工具"和"如何调用它们"。如果工具
没有出现在系统提示或 schema 中，模型就无法调用它。
