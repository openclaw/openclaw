---
summary: "斜杠命令：文本 vs 原生、配置和支持的命令"
read_when:
  - 使用或配置聊天命令
  - 调试命令路由或权限
title: "斜杠命令"
---

# 斜杠命令

命令由网关处理。大多数命令必须作为以 `/` 开头的**独立**消息发送。
仅主机的 bash 聊天命令使用 `! <cmd>`（`/bash <cmd>` 作为别名）。

有两个相关系统：

- **命令**：独立的 `/...` 消息。
- **指令**：`/think`、`/fast`、`/verbose`、`/trace`、`/reasoning`、`/elevated`、`/exec`、`/model`、`/queue`。
  - 指令在模型看到消息之前从消息中剥离。
  - 在普通聊天消息中（非仅指令），它们被视为“内联提示”，**不** 持久化会话设置。
  - 在仅指令消息中（消息仅包含指令），它们持久化到会话并回复确认。
  - 指令仅适用于**授权发送者**。如果设置了 `commands.allowFrom`，它是唯一使用的允许列表；否则授权来自通道允许列表/配对加上 `commands.useAccessGroups`。
    未授权发送者会将指令视为纯文本。

还有一些**内联快捷方式**（仅限允许列表/授权发送者）：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
它们立即运行，在模型看到消息之前被剥离，剩余文本继续通过正常流程。

## 配置

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    mcp: false,
    plugins: false,
    debug: false,
    restart: true,
    ownerAllowFrom: ["discord:123456789012345678"],
    ownerDisplay: "raw",
    ownerDisplaySecret: "${OWNER_ID_HASH_SECRET}",
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text`（默认 `true`）启用在聊天消息中解析 `/...`。
  - 在没有原生命令的界面（WhatsApp/WebChat/Signal/iMessage/Google Chat/Microsoft Teams）上，即使你将其设置为 `false`，文本命令仍然有效。
- `commands.native`（默认 `"auto"`）注册原生命令。
  - 自动：Discord/Telegram 开启；Slack 关闭（直到你添加斜杠命令）；对不支持原生命令的提供者忽略。
  - 设置 `channels.discord.commands.native`、`channels.telegram.commands.native` 或 `channels.slack.commands.native` 以按提供者覆盖（布尔值或 `"auto"`）。
  - `false` 在启动时清除 Discord/Telegram 上先前注册的命令。Slack 命令在 Slack 应用中管理，不会自动删除。
- `commands.nativeSkills`（默认 `"auto"`）在支持时原生注册**技能**命令。
  - 自动：Discord/Telegram 开启；Slack 关闭（Slack 需要为每个技能创建斜杠命令）。
  - 设置 `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills` 或 `channels.slack.commands.nativeSkills` 以按提供者覆盖（布尔值或 `"auto"`）。
- `commands.bash`（默认 `false`）启用 `! <cmd>` 运行主机 shell 命令（`/bash <cmd>` 是别名；需要 `tools.elevated` 允许列表）。
- `commands.bashForegroundMs`（默认 `2000`）控制 bash 在切换到后台模式之前等待多长时间（`0` 立即后台）。
- `commands.config`（默认 `false`）启用 `/config`（读取/写入 `openclaw.json`）。
- `commands.mcp`（默认 `false`）启用 `/mcp`（读取/写入 `mcp.servers` 下的 OpenClaw 管理的 MCP 配置）。
- `commands.plugins`（默认 `false`）启用 `/plugins`（插件发现/状态以及安装 + 启用/禁用控制）。
- `commands.debug`（默认 `false`）启用 `/debug`（仅运行时覆盖）。
- `commands.restart`（默认 `true`）启用 `/restart` 加上网关重启工具操作。
- `commands.ownerAllowFrom`（可选）为仅所有者命令/工具界面设置显式所有者允许列表。这与 `commands.allowFrom` 分开。
- `commands.ownerDisplay` 控制所有者 ID 在系统提示中的显示方式：`raw` 或 `hash`。
- `commands.ownerDisplaySecret` 可选地设置当 `commands.ownerDisplay="hash"` 时使用的 HMAC 密钥。
- `commands.allowFrom`（可选）为命令授权设置按提供者的允许列表。配置后，它是命令和指令的唯一授权源（通道允许列表/配对和 `commands.useAccessGroups` 被忽略）。使用 `"*"` 作为全局默认值；提供者特定的键覆盖它。
- `commands.useAccessGroups`（默认 `true`）在未设置 `commands.allowFrom` 时强制执行命令的允许列表/策略。

## 命令列表

当前事实来源：

- 核心内置命令来自 `src/auto-reply/commands-registry.shared.ts`
- 生成的 dock 命令来自 `src/auto-reply/commands-registry.data.ts`
- 插件命令来自插件 `registerCommand()` 调用
- 网关的实际可用性仍然取决于配置标志、通道界面和已安装/启用的插件

### 核心内置命令

今天可用的内置命令：

- `/new [model]` 开始新会话；`/reset` 是重置别名。
- `/compact [instructions]` 压缩会话上下文。请参阅 [/concepts/compaction](/concepts/compaction)。
- `/stop` 中止当前运行。
- `/session idle <duration|off>` 和 `/session max-age <duration|off>` 管理线程绑定过期。
- `/think <off|minimal|low|medium|high|xhigh>` 设置思考级别。别名：`/thinking`、`/t`。
- `/verbose on|off|full` 切换详细输出。别名：`/v`。
- `/trace on|off` 为当前会话切换插件跟踪输出。
- `/fast [status|on|off]` 显示或设置快速模式。
- `/reasoning [on|off|stream]` 切换推理可见性。别名：`/reason`。
- `/elevated [on|off|ask|full]` 切换提升模式。别名：`/elev`。
- `/exec host=<auto|sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` 显示或设置 exec 默认值。
- `/model [name|#|status]` 显示或设置模型。
- `/models [provider] [page] [limit=<n>|size=<n>|all]` 列出提供者或提供者的模型。
- `/queue <mode>` 管理队列行为（`steer`、`interrupt`、`followup`、`collect`、`steer-backlog`）加上选项，如 `debounce:2s cap:25 drop:summarize`。
- `/help` 显示简短的帮助摘要。
- `/commands` 显示生成的命令目录。
- `/tools [compact|verbose]` 显示当前代理现在可以使用什么。
- `/status` 显示运行时状态，包括提供者使用情况/配额（如果可用）。
- `/tasks` 列出当前会话的活动/最近后台任务。
- `/context [list|detail|json]` 解释上下文如何组装。
- `/export-session [path]` 将当前会话导出为 HTML。别名：`/export`。
- `/whoami` 显示你的发送者 ID。别名：`/id`。
- `/skill <name> [input]` 按名称运行技能。
- `/allowlist [list|add|remove] ...` 管理允许列表条目。仅文本。
- `/approve <id> <decision>` 解决 exec 批准提示。
- `/btw <question>` 提出附带问题而不更改未来会话上下文。请参阅 [/tools/btw](/tools/btw)。
- `/subagents list|kill|log|info|send|steer|spawn` 管理当前会话的子代理运行。
- `/acp spawn|cancel|steer|close|sessions|status|set-mode|set|cwd|permissions|timeout|model|reset-options|doctor|install|help` 管理 ACP 会话和运行时选项。
- `/focus <target>` 将当前 Discord 线程或 Telegram 主题/会话绑定到会话目标。
- `/unfocus` 移除当前绑定。
- `/agents` 列出当前会话的线程绑定代理。
- `/kill <id|#|all>` 中止一个或所有运行中的子代理。
- `/steer <id|#> <message>` 向运行中的子代理发送引导。别名：`/tell`。
- `/config show|get|set|unset` 读取或写入 `openclaw.json`。仅限所有者。需要 `commands.config: true`。
- `/mcp show|get|set|unset` 读取或写入 `mcp.servers` 下的 OpenClaw 管理的 MCP 服务器配置。仅限所有者。需要 `commands.mcp: true`。
- `/plugins list|inspect|show|get|install|enable|disable` 检查或改变插件状态。`/plugin` 是别名。写入仅限所有者。需要 `commands.plugins: true`。
- `/debug show|set|unset|reset` 管理仅运行时配置覆盖。仅限所有者。需要 `commands.debug: true`。
- `/usage off|tokens|full|cost` 控制每个响应的使用情况页脚或打印本地成本摘要。
- `/tts on|off|status|provider|limit|summary|audio|help` 控制 TTS。请参阅 [/tools/tts](/tools/tts)。
- `/restart` 启用时重启 OpenClaw。默认：启用；设置 `commands.restart: false` 禁用它。
- `/activation mention|always` 设置群组激活模式。
- `/send on|off|inherit` 设置发送策略。仅限所有者。
- `/bash <command>` 运行主机 shell 命令。仅文本。别名：`! <command>`。需要 `commands.bash: true` 加上 `tools.elevated` 允许列表。
- `!poll [sessionId]` 检查后台 bash 作业。
- `!stop [sessionId]` 停止后台 bash 作业。

### 生成的 dock 命令

Dock 命令从具有原生命令支持的通道插件生成。当前捆绑集：

- `/dock-discord`（别名：`/dock_discord`）
- `/dock-mattermost`（别名：`/dock_mattermost`）
- `/dock-slack`（别名：`/dock_slack`）
- `/dock-telegram`（别名：`/dock_telegram`）

### 捆绑插件命令

捆绑插件可以添加更多斜杠命令。此仓库中的当前捆绑命令：

- `/dreaming [on|off|status|help]` 切换内存做梦。请参阅 [做梦](/concepts/dreaming)。
- `/pair [qr|status|pending|approve|cleanup|notify]` 管理设备配对/设置流程。请参阅 [配对](/channels/pairing)。
- `/phone status|arm <camera|screen|writes|all> [duration]|disarm` 临时武装高风险手机节点命令。
- `/voice status|list [limit]|set <voiceId|name>` 管理 Talk 语音配置。在 Discord 上，原生命令名称是 `/talkvoice`。
- `/card ...` 发送 LINE 富卡片预设。请参阅 [LINE](/channels/line)。
- `/codex status|models|threads|resume|compact|review|account|mcp|skills` 检查和控制捆绑的 Codex 应用服务器 harness。请参阅 [Codex Harness](/plugins/codex-harness)。
- QQBot 专用命令：
  - `/bot-ping`
  - `/bot-version`
  - `/bot-help`
  - `/bot-upgrade`
  - `/bot-logs`

### 动态技能命令

用户可调用的技能也作为斜杠命令暴露：

- `/skill <name> [input]` 始终作为通用入口点工作。
- 技能也可能作为直接命令出现，如 `/prose`，当技能/插件注册它们时。
- 原生技能命令注册由 `commands.nativeSkills` 和 `channels.<provider>.commands.nativeSkills` 控制。

注意：

- 命令接受命令和参数之间的可选 `:`（例如 `/think: high`、`/send: on`、`/help:`）。
- `/new <model>` 接受模型别名、`provider/model` 或提供者名称（模糊匹配）；如果没有匹配，文本被视为消息正文。
- 对于完整的提供者使用情况细分，使用 `openclaw status --usage`。
- `/allowlist add|remove` 需要 `commands.config=true` 并遵守通道 `configWrites`。
- 在多账户通道中，配置目标的 `/allowlist --account <id>` 和 `/config set channels.<provider>.accounts.<id>...` 也遵守目标账户的 `configWrites`。
- `/usage` 控制每个响应的使用情况页脚；`/usage cost` 从 OpenClaw 会话日志打印本地成本摘要。
- `/restart` 默认启用；设置 `commands.restart: false` 禁用它。
- `/plugins install <spec>` 接受与 `openclaw plugins install` 相同的插件规范：本地路径/存档、npm 包或 `clawhub:<pkg>`。
- `/plugins enable|disable` 更新插件配置并可能提示重启。
- Discord 专用原生命令：`/vc join|leave|status` 控制语音通道（需要 `channels.discord.voice` 和原生命令；不可作为文本使用）。
- Discord 线程绑定命令（`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age`）需要启用有效的线程绑定（`session.threadBindings.enabled` 和/或 `channels.discord.threadBindings.enabled`）。
- ACP 命令参考和运行时行为：[ACP 代理](/tools/acp-agents)。
- `/verbose` 用于调试和额外可见性；在正常使用中保持**关闭**。
- `/trace` 比 `/verbose` 更窄：它只显示插件拥有的跟踪/调试行，并保持正常的详细工具聊天关闭。
- `/fast on|off` 持久化会话覆盖。使用 Sessions UI `inherit` 选项清除它并回退到配置默认值。
- `/fast` 是提供者特定的：OpenAI/OpenAI Codex 将其映射到原生 Responses 端点上的 `service_tier=priority`，而直接公开的 Anthropic 请求，包括发送到 `api.anthropic.com` 的 OAuth 认证流量，将其映射到 `service_tier=auto` 或 `standard_only`。请参阅 [OpenAI](/providers/openai) 和 [Anthropic](/providers/anthropic)。
- 工具失败摘要在相关时仍然显示，但详细的失败文本仅在 `/verbose` 为 `on` 或 `full` 时包含。
- `/reasoning`、`/verbose` 和 `/trace` 在群组设置中存在风险：它们可能会揭示你不打算暴露的内部推理、工具输出或插件诊断。尤其是在群组聊天中，最好保持它们关闭。
- `/model` 立即持久化新会话模型。
- 如果代理空闲，下一次运行会立即使用它。
- 如果运行已经活跃，OpenClaw 标记实时切换为待处理，并且只在干净的重试点重新启动到新模型。
- 如果工具活动或回复输出已经开始，待处理的切换可以保持排队，直到稍后的重试机会或下一个用户回合。
- **快速路径**：来自允许列表发送者的仅命令消息立即处理（绕过队列 + 模型）。
- **群组提及门控**：来自允许列表发送者的仅命令消息绕过提及要求。
- **内联快捷方式（仅限允许列表发送者）**：某些命令也可以在嵌入到普通消息时工作，并在模型看到剩余文本之前被剥离。
  - 示例：`hey /status` 触发状态回复，剩余文本继续通过正常流程。
- 当前：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
- 未授权的仅命令消息被静默忽略，内联 `/...` 令牌被视为纯文本。
- **技能命令**：`user-invocable` 技能作为斜杠命令暴露。名称被清理为 `a-z0-9_`（最多 32 个字符）；冲突获得数字后缀（例如 `_2`）。
  - `/skill <name> [input]` 按名称运行技能（当原生命令限制阻止每个技能命令时很有用）。
  - 默认情况下，技能命令作为普通请求转发给模型。
  - 技能可以选择声明 `command-dispatch: tool` 以将命令直接路由到工具（确定性，无模型）。
  - 示例：`/prose`（OpenProse 插件）— 请参阅 [OpenProse](/prose)。
- **原生命令参数**：Discord 为动态选项使用自动完成（当你省略必需参数时使用按钮菜单）。当命令支持选择且你省略参数时，Telegram 和 Slack 显示按钮菜单。

## `/tools`

`/tools` 回答运行时问题，而不是配置问题：**此代理现在在
此会话中可以使用什么**。

- 默认 `/tools` 紧凑且优化用于快速扫描。
- `/tools verbose` 添加简短描述。
- 支持参数的原生命令界面暴露与 `compact|verbose` 相同的模式开关。
- 结果是会话范围的，因此更改代理、通道、线程、发送者授权或模型可以
  更改输出。
- `/tools` 包括在运行时实际可达的工具，包括核心工具、连接的
  插件工具和通道拥有的工具。

对于配置文件和覆盖编辑，请使用 Control UI 工具面板或配置/目录界面，而不是将 `/tools` 视为静态目录。

## 使用界面（什么显示在哪里）

- **提供者使用情况/配额**（示例：“Claude 80% 剩余”）在启用使用情况跟踪时显示在当前模型提供者的 `/status` 中。OpenClaw 将提供者窗口标准化为 `% 剩余`；对于 MiniMax，剩余百分比字段在显示前被反转，`model_remains` 响应更喜欢聊天模型条目加上模型标记的计划标签。
- `/status` 中的 **令牌/缓存行** 当实时会话快照稀疏时可以回退到最新的转录使用条目。现有的非零实时值仍然获胜，转录回退还可以恢复活动运行时模型标签加上更大的面向提示的总数，当存储的总数缺失或较小时。
- **每个响应的令牌/成本** 由 `/usage off|tokens|full` 控制（附加到正常回复）。
- `/model status` 关于**模型/认证/端点**，而不是使用情况。

## 模型选择（`/model`）

`/model` 被实现为指令。

示例：

```
/model
/model list
/model 3
/model openai/gpt-5.4
/model opus@anthropic:default
/model status
```

注意：

- `/model` 和 `/model list` 显示紧凑的编号选择器（模型系列 + 可用提供者）。
- 在 Discord 上，`/model` 和 `/models` 打开交互式选择器，带有提供者和模型下拉菜单以及提交步骤。
- `/model <#>` 从该选择器中选择（并在可能时偏好当前提供者）。
- `/model status` 显示详细视图，包括配置的提供者端点（`baseUrl`）和 API 模式（`api`）（如果可用）。

## 调试覆盖

`/debug` 允许你设置**仅运行时**配置覆盖（内存，不是磁盘）。仅限所有者。默认禁用；使用 `commands.debug: true` 启用。

示例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

注意：

- 覆盖立即应用于新的配置读取，但**不**写入 `openclaw.json`。
- 使用 `/debug reset` 清除所有覆盖并返回磁盘上的配置。

## 插件跟踪输出

`/trace` 允许你在不打开完全详细模式的情况下切换**会话范围的插件跟踪/调试行**。

示例：

```text
/trace
/trace on
/trace off
```

注意：

- 无参数的 `/trace` 显示当前会话跟踪状态。
- `/trace on` 为当前会话启用插件跟踪行。
- `/trace off` 再次禁用它们。
- 插件跟踪行可以出现在 `/status` 中，并作为正常助手回复后的后续诊断消息。
- `/trace` 不替换 `/debug`；`/debug` 仍然管理仅运行时配置覆盖。
- `/trace` 不替换 `/verbose`；正常的详细工具/状态输出仍然属于 `/verbose`。

## 配置更新

`/config` 写入你的磁盘配置（`openclaw.json`）。仅限所有者。默认禁用；使用 `commands.config: true` 启用。

示例：

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注意：

- 写入前验证配置；无效更改被拒绝。
- `/config` 更新在重启之间持久化。

## MCP 更新

`/mcp` 写入 `mcp.servers` 下的 OpenClaw 管理的 MCP 服务器定义。仅限所有者。默认禁用；使用 `commands.mcp: true` 启用。

示例：

```text
/mcp show
/mcp show context7
/mcp set context7={"command":"uvx","args":["context7-mcp"]}
/mcp unset context7
```

注意：

- `/mcp` 将配置存储在 OpenClaw 配置中，而不是 Pi 拥有的项目设置中。
- 运行时适配器决定哪些传输实际上是可执行的。

## 插件更新

`/plugins` 允许操作员检查发现的插件并在配置中切换启用。只读流程可以使用 `/plugin` 作为别名。默认禁用；使用 `commands.plugins: true` 启用。

示例：

```text
/plugins
/plugins list
/plugin show context7
/plugins enable context7
/plugins disable context7
```

注意：

- `/plugins list` 和 `/plugins show` 使用针对当前工作区加上磁盘配置的真实插件发现。
- `/plugins enable|disable` 仅更新插件配置；它不安装或卸载插件。
- 启用/禁用更改后，重启网关以应用它们。

## 界面注意事项

- **文本命令** 在正常聊天会话中运行（DM 共享 `main`，群组有自己的会话）。
- **原生命令** 使用隔离会话：
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>`（前缀可通过 `channels.slack.slashCommand.sessionPrefix` 配置）
  - Telegram: `telegram:slash:<userId>`（通过 `CommandTargetSessionKey` 定位聊天会话）
- **`/stop`** 定位活动聊天会话，以便它可以中止当前运行。
- **Slack**：`channels.slack.slashCommand` 仍然支持单个 `/openclaw` 风格的命令。如果你启用 `commands.native`，你必须为每个内置命令创建一个 Slack 斜杠命令（与 `/help` 相同的名称）。Slack 的命令参数菜单作为临时 Block Kit 按钮传递。
  - Slack 原生例外：注册 `/agentstatus`（不是 `/status`），因为 Slack 保留 `/status`。文本 `/status` 在 Slack 消息中仍然有效。

## BTW 附带问题

`/btw` 是关于当前会话的快速**附带问题**。

与正常聊天不同：

- 它使用当前会话作为背景上下文，
- 它作为单独的**无工具**一次性调用运行，
- 它不改变未来会话上下文，
- 它不写入转录历史，
- 它作为实时附带结果而不是正常助手消息传递。

这使得 `/btw` 在你希望在主要任务继续进行的同时获得临时澄清时很有用。

示例：

```text
/btw what are we doing right now?
```

请参阅 [BTW 附带问题](/tools/btw) 了解完整行为和客户端 UX 详细信息。