---
read_when:
  - 使用或配置聊天命令
  - 调试命令路由或权限问题
summary: 斜杠命令：文本与原生命令、配置及支持的命令
title: 斜杠命令
x-i18n:
  generated_at: "2026-02-01T21:43:36Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ca0deebf89518e8c62828fbb9bf4621c5fff8ab86ccb22e37da61a28f9a7886a
  source_path: tools/slash-commands.md
  workflow: 15
---

# 斜杠命令

命令由 Gateway网关处理。大多数命令必须作为以 `/` 开头的**独立**消息发送。
仅限主机使用的 bash 聊天命令使用 `! <cmd>`（`/bash <cmd>` 为别名）。

有两个相关系统：

- **命令**：独立的 `/...` 消息。
- **指令**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/exec`、`/model`、`/queue`。
  - 指令在模型看到消息之前会被移除。
  - 在普通聊天消息（非纯指令消息）中，它们被视为"内联提示"，**不会**持久化会话设置。
  - 在纯指令消息（消息仅包含指令）中，它们会持久化到会话并回复确认信息。
  - 指令仅对**已授权的发送者**（渠道允许列表/配对加上 `commands.useAccessGroups`）生效。
    未授权的发送者看到的指令会被当作纯文本处理。

还有一些**内联快捷命令**（仅限已加入允许列表/已授权的发送者）：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
它们会立即执行，在模型看到消息之前被移除，剩余文本继续通过正常流程处理。

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
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text`（默认 `true`）启用解析聊天消息中的 `/...`。
  - 在没有原生命令支持的平台上（WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams），即使将此项设为 `false`，文本命令仍然有效。
- `commands.native`（默认 `"auto"`）注册原生命令。
  - Auto：Discord/Telegram 启用；Slack 关闭（直到你添加斜杠命令）；不支持原生命令的提供商忽略此项。
  - 设置 `channels.discord.commands.native`、`channels.telegram.commands.native` 或 `channels.slack.commands.native` 可按提供商覆盖（布尔值或 `"auto"`）。
  - `false` 会在启动时清除 Discord/Telegram 上之前注册的命令。Slack 命令在 Slack 应用中管理，不会自动移除。
- `commands.nativeSkills`（默认 `"auto"`）在支持的平台上将**Skills**命令注册为原生命令。
  - Auto：Discord/Telegram 启用；Slack 关闭（Slack 需要为每个 Skills 创建一个斜杠命令）。
  - 设置 `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills` 或 `channels.slack.commands.nativeSkills` 可按提供商覆盖（布尔值或 `"auto"`）。
- `commands.bash`（默认 `false`）启用 `! <cmd>` 来运行主机 shell 命令（`/bash <cmd>` 为别名；需要 `tools.elevated` 允许列表）。
- `commands.bashForegroundMs`（默认 `2000`）控制 bash 在切换到后台模式之前等待的时长（`0` 表示立即后台执行）。
- `commands.config`（默认 `false`）启用 `/config`（读写 `openclaw.json`）。
- `commands.debug`（默认 `false`）启用 `/debug`（仅运行时覆盖）。
- `commands.useAccessGroups`（默认 `true`）对命令强制执行允许列表/策略。

## 命令列表

文本 + 原生命令（启用时）：

- `/help`
- `/commands`
- `/skill <name> [input]`（按名称运行 Skills）
- `/status`（显示当前状态；在可用时包含当前模型提供商的用量/配额信息）
- `/allowlist`（列出/添加/移除允许列表条目）
- `/approve <id> allow-once|allow-always|deny`（处理执行审批提示）
- `/context [list|detail|json]`（解释"上下文"；`detail` 显示每个文件 + 每个工具 + 每个 Skills + 系统提示的大小）
- `/whoami`（显示你的发送者 ID；别名：`/id`）
- `/subagents list|stop|log|info|send`（检查、停止、查看日志或向当前会话的子智能体运行发送消息）
- `/config show|get|set|unset`（将配置持久化到磁盘，仅所有者可用；需要 `commands.config: true`）
- `/debug show|set|unset|reset`（运行时覆盖，仅所有者可用；需要 `commands.debug: true`）
- `/usage off|tokens|full|cost`（每次响应的用量页脚或本地费用摘要）
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio`（控制 TTS；参见 [/tts](/tts)）
  - Discord：原生命令为 `/voice`（Discord 保留了 `/tts`）；文本命令 `/tts` 仍然有效。
- `/stop`
- `/restart`
- `/dock-telegram`（别名：`/dock_telegram`）（将回复切换到 Telegram）
- `/dock-discord`（别名：`/dock_discord`）（将回复切换到 Discord）
- `/dock-slack`（别名：`/dock_slack`）（将回复切换到 Slack）
- `/activation mention|always`（仅群组）
- `/send on|off|inherit`（仅所有者）
- `/reset` 或 `/new [model]`（可选模型提示；剩余内容直接传递）
- `/think <off|minimal|low|medium|high|xhigh>`（按模型/提供商动态选择；别名：`/thinking`、`/t`）
- `/verbose on|full|off`（别名：`/v`）
- `/reasoning on|off|stream`（别名：`/reason`；开启时发送以 `Reasoning:` 为前缀的单独消息；`stream` = 仅限 Telegram 草稿）
- `/elevated on|off|ask|full`（别名：`/elev`；`full` 跳过执行审批）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`（发送 `/exec` 查看当前设置）
- `/model <name>`（别名：`/models`；或来自 `agents.defaults.models.*.alias` 的 `/<alias>`）
- `/queue <mode>`（加上选项如 `debounce:2s cap:25 drop:summarize`；发送 `/queue` 查看当前设置）
- `/bash <command>`（仅限主机；`! <command>` 的别名；需要 `commands.bash: true` + `tools.elevated` 允许列表）

仅文本命令：

- `/compact [instructions]`（参见 [/concepts/compaction](/concepts/compaction)）
- `! <command>`（仅限主机；一次一个；对长时间运行的任务使用 `!poll` + `!stop`）
- `!poll`（检查输出/状态；接受可选的 `sessionId`；`/bash poll` 也可用）
- `!stop`（停止正在运行的 bash 任务；接受可选的 `sessionId`；`/bash stop` 也可用）

注意事项：

- 命令在命令名和参数之间可以使用可选的 `:`（例如 `/think: high`、`/send: on`、`/help:`）。
- `/new <model>` 接受模型别名、`provider/model` 或提供商名称（模糊匹配）；如果没有匹配，文本将被视为消息正文。
- 要查看完整的提供商用量明细，请使用 `openclaw status --usage`。
- `/allowlist add|remove` 需要 `commands.config=true` 并遵循渠道的 `configWrites` 设置。
- `/usage` 控制每次响应的用量页脚；`/usage cost` 从 OpenClaw 会话日志中打印本地费用摘要。
- `/restart` 默认禁用；设置 `commands.restart: true` 以启用。
- `/verbose` 用于调试和增强可见性；正常使用时请保持**关闭**。
- `/reasoning`（和 `/verbose`）在群组场景中存在风险：它们可能暴露你不希望公开的内部推理或工具输出。建议保持关闭，尤其是在群聊中。
- **快速路径：**来自已加入允许列表发送者的纯命令消息会立即处理（绕过队列 + 模型）。
- **群组提及门控：**来自已加入允许列表发送者的纯命令消息会绕过提及要求。
- **内联快捷命令（仅限已加入允许列表的发送者）：**某些命令也可以嵌入在普通消息中使用，在模型看到剩余文本之前会被移除。
  - 示例：`hey /status` 会触发状态回复，剩余文本继续通过正常流程处理。
- 目前支持：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
- 未授权的纯命令消息会被静默忽略，内联的 `/...` 标记会被当作纯文本处理。
- **Skills 命令：**`user-invocable` Skills 会作为斜杠命令暴露。名称会被规范化为 `a-z0-9_`（最多 32 个字符）；冲突时会添加数字后缀（例如 `_2`）。
  - `/skill <name> [input]` 按名称运行 Skills（在原生命令限制阻止创建逐 Skills 命令时很有用）。
  - 默认情况下，Skills 命令会作为普通请求转发给模型。
  - Skills 可以选择性地声明 `command-dispatch: tool` 将命令直接路由到工具（确定性执行，无需模型）。
  - 示例：`/prose`（OpenProse 插件）——参见 [OpenProse](/prose)。
- **原生命令参数：**Discord 使用自动补全来处理动态选项（省略必需参数时使用按钮菜单）。Telegram 和 Slack 在命令支持选项且省略参数时显示按钮菜单。

## 用量显示界面（在哪里显示什么）

- **提供商用量/配额**（示例："Claude 剩余 80%"）在启用用量跟踪时显示在 `/status` 中，针对当前模型提供商。
- **每次响应的令牌数/费用**由 `/usage off|tokens|full` 控制（附加在普通回复后面）。
- `/model status` 关于的是**模型/认证/端点**，而非用量。

## 模型选择（`/model`）

`/model` 作为指令实现。

示例：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

注意事项：

- `/model` 和 `/model list` 显示紧凑的编号选择器（模型系列 + 可用提供商）。
- `/model <#>` 从该选择器中选择（尽可能优先使用当前提供商）。
- `/model status` 显示详细视图，包括已配置的提供商端点（`baseUrl`）和 API 模式（`api`）（如可用）。

## 调试覆盖

`/debug` 允许你设置**仅运行时**的配置覆盖（内存中，不写入磁盘）。仅所有者可用。默认禁用；通过 `commands.debug: true` 启用。

示例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

注意事项：

- 覆盖会立即应用于新的配置读取，但**不会**写入 `openclaw.json`。
- 使用 `/debug reset` 清除所有覆盖并恢复到磁盘上的配置。

## 配置更新

`/config` 写入你的磁盘配置（`openclaw.json`）。仅所有者可用。默认禁用；通过 `commands.config: true` 启用。

示例：

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注意事项：

- 配置在写入前会进行验证；无效的更改会被拒绝。
- `/config` 更新在重启后仍然保留。

## 平台说明

- **文本命令**在普通聊天会话中运行（私信共享 `main`，群组有各自的会话）。
- **原生命令**使用隔离的会话：
  - Discord：`agent:<agentId>:discord:slash:<userId>`
  - Slack：`agent:<agentId>:slack:slash:<userId>`（前缀可通过 `channels.slack.slashCommand.sessionPrefix` 配置）
  - Telegram：`telegram:slash:<userId>`（通过 `CommandTargetSessionKey` 定位聊天会话）
- **`/stop`** 定位活跃的聊天会话，以便中止当前运行。
- **Slack：**仍然支持 `channels.slack.slashCommand` 用于单个 `/openclaw` 风格的命令。如果你启用了 `commands.native`，则必须为每个内置命令创建一个 Slack 斜杠命令（名称与 `/help` 相同）。Slack 的命令参数菜单以临时 Block Kit 按钮形式呈现。
