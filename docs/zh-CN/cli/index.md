---
read_when:
  - 添加或修改 CLI 命令或选项
  - 为新的命令界面编写文档
summary: OpenClaw `openclaw` 命令、子命令和选项的 CLI 参考
title: CLI 参考
x-i18n:
  generated_at: "2026-02-01T20:02:06Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a73923763d7b89d4b183f569d543927ffbfd1f3e02f9e66639913f6daf226850
  source_path: cli/index.md
  workflow: 14
---

# CLI 参考

本页描述当前的 CLI 行为。如果命令发生变更，请更新此文档。

## 命令页面

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins)（插件命令）
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall)（插件；需已安装）

## 全局参数

- `--dev`：将状态隔离到 `~/.openclaw-dev` 并偏移默认端口。
- `--profile <name>`：将状态隔离到 `~/.openclaw-<name>`。
- `--no-color`：禁用 ANSI 颜色。
- `--update`：`openclaw update` 的简写（仅限源码安装）。
- `-V`、`--version`、`-v`：打印版本并退出。

## 输出样式

- ANSI 颜色和进度指示器仅在 TTY 会话中渲染。
- OSC-8 超链接在支持的终端中显示为可点击链接；否则回退为纯 URL。
- `--json`（以及支持的 `--plain`）禁用样式以获得干净输出。
- `--no-color` 禁用 ANSI 样式；同样支持 `NO_COLOR=1`。
- 长时间运行的命令会显示进度指示器（支持时使用 OSC 9;4）。

## 配色方案

OpenClaw 使用龙虾色配色方案作为 CLI 输出。

- `accent`（#FF5A2D）：标题、标签、主要高亮。
- `accentBright`（#FF7A3D）：命令名称、强调。
- `accentDim`（#D14A22）：次要高亮文本。
- `info`（#FF8A5B）：信息值。
- `success`（#2FBF71）：成功状态。
- `warn`（#FFB020）：警告、回退、注意。
- `error`（#E23D2D）：错误、失败。
- `muted`（#8B7F77）：弱化、元数据。

配色方案的权威来源：`src/terminal/palette.ts`（即 "lobster seam"）。

## 命令树

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

注意：插件可以添加额外的顶层命令（例如 `openclaw voicecall`）。

## 安全

- `openclaw security audit` — 审计配置和本地状态中常见的安全隐患。
- `openclaw security audit --deep` — 尽力进行实时 Gateway网关探测。
- `openclaw security audit --fix` — 收紧安全默认设置并修改状态/配置文件权限。

## 插件

管理扩展及其配置：

- `openclaw plugins list` — 发现插件（使用 `--json` 获取机器可读输出）。
- `openclaw plugins info <id>` — 显示插件详情。
- `openclaw plugins install <path|.tgz|npm-spec>` — 安装插件（或将插件路径添加到 `plugins.load.paths`）。
- `openclaw plugins enable <id>` / `disable <id>` — 切换 `plugins.entries.<id>.enabled`。
- `openclaw plugins doctor` — 报告插件加载错误。

大多数插件变更需要重启 Gateway网关。参见 [/plugin](/plugin)。

## 记忆

对 `MEMORY.md` + `memory/*.md` 进行向量搜索：

- `openclaw memory status` — 显示索引统计信息。
- `openclaw memory index` — 重新索引记忆文件。
- `openclaw memory search "<query>"` — 对记忆进行语义搜索。

## 聊天斜杠命令

聊天消息支持 `/...` 命令（文本和原生）。参见 [/tools/slash-commands](/tools/slash-commands)。

亮点：

- `/status` 用于快速诊断。
- `/config` 用于持久化配置更改。
- `/debug` 用于仅运行时的配置覆盖（内存中，不写入磁盘；需要 `commands.debug: true`）。

## 设置与新手引导

### `setup`

初始化配置和工作区。

选项：

- `--workspace <dir>`：智能体工作区路径（默认 `~/.openclaw/workspace`）。
- `--wizard`：运行新手引导向导。
- `--non-interactive`：无提示运行向导。
- `--mode <local|remote>`：向导模式。
- `--remote-url <url>`：远程 Gateway网关 URL。
- `--remote-token <token>`：远程 Gateway网关令牌。

当存在任何向导参数（`--non-interactive`、`--mode`、`--remote-url`、`--remote-token`）时，向导会自动运行。

### `onboard`

交互式向导，用于设置 Gateway网关、工作区和 Skills。

选项：

- `--workspace <dir>`
- `--reset`（在向导运行前重置配置 + 凭证 + 会话 + 工作区）
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>`（manual 是 advanced 的别名）
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>`（非交互式；与 `--auth-choice token` 配合使用）
- `--token <token>`（非交互式；与 `--auth-choice token` 配合使用）
- `--token-profile-id <id>`（非交互式；默认：`<provider>:manual`）
- `--token-expires-in <duration>`（非交互式；例如 `365d`、`12h`）
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon`（别名：`--skip-daemon`）
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>`（推荐 pnpm；不建议将 bun 用于 Gateway网关运行时）
- `--json`

### `configure`

交互式配置向导（模型、渠道、Skills、Gateway网关）。

### `config`

非交互式配置辅助工具（get/set/unset）。不带子命令运行 `openclaw config` 将启动向导。

子命令：

- `config get <path>`：打印配置值（点号/方括号路径）。
- `config set <path> <value>`：设置值（JSON5 或原始字符串）。
- `config unset <path>`：移除值。

### `doctor`

健康检查和快速修复（配置 + Gateway网关 + 旧版服务）。

选项：

- `--no-workspace-suggestions`：禁用工作区记忆提示。
- `--yes`：无需提示接受默认值（无头模式）。
- `--non-interactive`：跳过提示；仅应用安全迁移。
- `--deep`：扫描系统服务以查找额外的 Gateway网关安装。

## 渠道辅助工具

### `channels`

管理聊天渠道账号（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（插件）/Signal/iMessage/MS Teams）。

子命令：

- `channels list`：显示已配置的渠道和认证配置。
- `channels status`：检查 Gateway网关可达性和渠道健康状态（`--probe` 运行额外检查；使用 `openclaw health` 或 `openclaw status --deep` 进行 Gateway网关健康探测）。
- 提示：`channels status` 在检测到常见配置错误时会打印警告并提供修复建议（然后引导你使用 `openclaw doctor`）。
- `channels logs`：显示来自 Gateway网关日志文件的最近渠道日志。
- `channels add`：不传参数时以向导模式设置；传入参数则切换为非交互模式。
- `channels remove`：默认仅禁用；传入 `--delete` 可无提示删除配置条目。
- `channels login`：交互式渠道登录（仅限 WhatsApp Web）。
- `channels logout`：登出渠道会话（如果支持）。

通用选项：

- `--channel <name>`：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`：渠道账号 ID（默认 `default`）
- `--name <label>`：账号的显示名称

`channels login` 选项：

- `--channel <channel>`（默认 `whatsapp`；支持 `whatsapp`/`web`）
- `--account <id>`
- `--verbose`

`channels logout` 选项：

- `--channel <channel>`（默认 `whatsapp`）
- `--account <id>`

`channels list` 选项：

- `--no-usage`：跳过模型提供商用量/配额快照（仅限 OAuth/API 支持的）。
- `--json`：输出 JSON（除非设置了 `--no-usage`，否则包含用量信息）。

`channels logs` 选项：

- `--channel <name|all>`（默认 `all`）
- `--lines <n>`（默认 `200`）
- `--json`

更多详情：[/concepts/oauth](/concepts/oauth)

示例：

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

列出和检查可用 Skills 及就绪信息。

子命令：

- `skills list`：列出 Skills（无子命令时的默认行为）。
- `skills info <name>`：显示某个 Skills 的详情。
- `skills check`：就绪与缺失需求的摘要。

选项：

- `--eligible`：仅显示就绪的 Skills。
- `--json`：输出 JSON（无样式）。
- `-v`、`--verbose`：包含缺失需求的详情。

提示：使用 `npx clawhub` 搜索、安装和同步 Skills。

### `pairing`

跨渠道审批私聊配对请求。

子命令：

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub 钩子设置与运行。参见 [/automation/gmail-pubsub](/automation/gmail-pubsub)。

子命令：

- `webhooks gmail setup`（需要 `--account <email>`；支持 `--project`、`--topic`、`--subscription`、`--label`、`--hook-url`、`--hook-token`、`--push-token`、`--bind`、`--port`、`--path`、`--include-body`、`--max-bytes`、`--renew-minutes`、`--tailscale`、`--tailscale-path`、`--tailscale-target`、`--push-endpoint`、`--json`）
- `webhooks gmail run`（相同参数的运行时覆盖）

### `dns setup`

广域发现 DNS 辅助工具（CoreDNS + Tailscale）。参见 [/gateway/discovery](/gateway/discovery)。

选项：

- `--apply`：安装/更新 CoreDNS 配置（需要 sudo；仅限 macOS）。

## 消息与智能体

### `message`

统一的出站消息和渠道操作。

参见：[/cli/message](/cli/message)

子命令：

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

示例：

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

通过 Gateway网关（或 `--local` 嵌入模式）运行一个智能体回合。

必需：

- `--message <text>`

选项：

- `--to <dest>`（用于会话键和可选的投递）
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>`（仅限 GPT-5.2 + Codex 模型）
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

管理隔离的智能体（工作区 + 认证 + 路由）。

#### `agents list`

列出已配置的智能体。

选项：

- `--json`
- `--bindings`

#### `agents add [name]`

添加新的隔离智能体。除非传入参数（或 `--non-interactive`），否则运行引导向导；非交互模式下 `--workspace` 为必需。

选项：

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>`（可重复）
- `--non-interactive`
- `--json`

绑定规格使用 `channel[:accountId]`。当 WhatsApp 省略 `accountId` 时，使用默认账号 ID。

#### `agents delete <id>`

删除智能体并清理其工作区和状态。

选项：

- `--force`
- `--json`

### `acp`

运行将 IDE 连接到 Gateway网关的 ACP 桥接。

参见 [`acp`](/cli/acp) 获取完整选项和示例。

### `status`

显示已关联会话的健康状态和最近的接收者。

选项：

- `--json`
- `--all`（完整诊断；只读，可粘贴）
- `--deep`（探测渠道）
- `--usage`（显示模型提供商用量/配额）
- `--timeout <ms>`
- `--verbose`
- `--debug`（`--verbose` 的别名）

说明：

- 概览在可用时包含 Gateway网关 + 节点主机服务状态。

### 用量追踪

当 OAuth/API 凭证可用时，OpenClaw 可以展示提供商的用量/配额信息。

展示位置：

- `/status`（可用时添加简短的提供商用量行）
- `openclaw status --usage`（打印完整的提供商用量明细）
- macOS 菜单栏（Context 下的用量部分）

说明：

- 数据直接来自提供商的用量端点（非估算值）。
- 提供商：Anthropic、GitHub Copilot、OpenAI Codex OAuth，以及启用相应提供商插件时的 Gemini CLI/Antigravity。
- 如果没有匹配的凭证，用量信息将被隐藏。
- 详情：参见 [用量追踪](/concepts/usage-tracking)。

### `health`

从运行中的 Gateway网关获取健康状态。

选项：

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

列出已存储的对话会话。

选项：

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## 重置/卸载

### `reset`

重置本地配置/状态（保留 CLI 安装）。

选项：

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

说明：

- `--non-interactive` 需要同时指定 `--scope` 和 `--yes`。

### `uninstall`

卸载 Gateway网关服务和本地数据（CLI 保留）。

选项：

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

说明：

- `--non-interactive` 需要 `--yes` 和明确的范围（或 `--all`）。

## Gateway网关

### `gateway`

运行 WebSocket Gateway网关。

选项：

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset`（重置开发配置 + 凭证 + 会话 + 工作区）
- `--force`（终止端口上的现有监听器）
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact`（`--ws-log compact` 的别名）
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

管理 Gateway网关服务（launchd/systemd/schtasks）。

子命令：

- `gateway status`（默认探测 Gateway网关 RPC）
- `gateway install`（服务安装）
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

说明：

- `gateway status` 默认使用服务解析的端口/配置探测 Gateway网关 RPC（可通过 `--url/--token/--password` 覆盖）。
- `gateway status` 支持 `--no-probe`、`--deep` 和 `--json` 用于脚本编写。
- `gateway status` 还会在检测到旧版或额外的 Gateway网关服务时展示（`--deep` 添加系统级扫描）。以配置文件命名的 OpenClaw 服务被视为正式服务，不会被标记为"额外"。
- `gateway status` 会打印 CLI 使用的配置路径与服务可能使用的配置（服务环境变量），以及解析后的探测目标 URL。
- `gateway install|uninstall|start|stop|restart` 支持 `--json` 用于脚本编写（默认输出保持人类可读）。
- `gateway install` 默认使用 Node 运行时；**不建议**使用 bun（WhatsApp/Telegram 存在 bug）。
- `gateway install` 选项：`--port`、`--runtime`、`--token`、`--force`、`--json`。

### `logs`

通过 RPC 追踪 Gateway网关文件日志。

说明：

- TTY 会话渲染彩色结构化视图；非 TTY 回退为纯文本。
- `--json` 输出行分隔的 JSON（每行一个日志事件）。

示例：

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway网关 CLI 辅助工具（RPC 子命令使用 `--url`、`--token`、`--password`、`--timeout`、`--expect-final`）。

子命令：

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

常用 RPC：

- `config.apply`（验证 + 写入配置 + 重启 + 唤醒）
- `config.patch`（合并部分更新 + 重启 + 唤醒）
- `update.run`（运行更新 + 重启 + 唤醒）

提示：直接调用 `config.set`/`config.apply`/`config.patch` 时，如果配置已存在，请传入来自 `config.get` 的 `baseHash`。

## 模型

参见 [/concepts/models](/concepts/models) 了解回退行为和扫描策略。

推荐的 Anthropic 认证方式（setup-token）：

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models`（根命令）

`openclaw models` 是 `models status` 的别名。

根选项：

- `--status-json`（`models status --json` 的别名）
- `--status-plain`（`models status --plain` 的别名）

### `models list`

选项：

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

选项：

- `--json`
- `--plain`
- `--check`（退出码 1=已过期/缺失，2=即将过期）
- `--probe`（对已配置的认证配置进行实时探测）
- `--probe-provider <name>`
- `--probe-profile <id>`（可重复或逗号分隔）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

始终包含认证概览和认证存储中配置的 OAuth 过期状态。
`--probe` 运行实时请求（可能消耗令牌并触发速率限制）。

### `models set <model>`

设置 `agents.defaults.model.primary`。

### `models set-image <model>`

设置 `agents.defaults.imageModel.primary`。

### `models aliases list|add|remove`

选项：

- `list`：`--json`、`--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

选项：

- `list`：`--json`、`--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

选项：

- `list`：`--json`、`--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

选项：

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

选项：

- `add`：交互式认证辅助工具
- `setup-token`：`--provider <name>`（默认 `anthropic`）、`--yes`
- `paste-token`：`--provider <name>`、`--profile-id <id>`、`--expires-in <duration>`

### `models auth order get|set|clear`

选项：

- `get`：`--provider <name>`、`--agent <id>`、`--json`
- `set`：`--provider <name>`、`--agent <id>`、`<profileIds...>`
- `clear`：`--provider <name>`、`--agent <id>`

## 系统

### `system event`

入队系统事件并可选触发心跳（Gateway网关 RPC）。

必需：

- `--text <text>`

选项：

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

### `system heartbeat last|enable|disable`

心跳控制（Gateway网关 RPC）。

选项：

- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

### `system presence`

列出系统存在条目（Gateway网关 RPC）。

选项：

- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

## 定时任务

管理调度作业（Gateway网关 RPC）。参见 [/automation/cron-jobs](/automation/cron-jobs)。

子命令：

- `cron status [--json]`
- `cron list [--all] [--json]`（默认表格输出；使用 `--json` 获取原始数据）
- `cron add`（别名：`create`；需要 `--name` 和 `--at` | `--every` | `--cron` 三选一，以及 `--system-event` | `--message` 二选一的负载）
- `cron edit <id>`（修补字段）
- `cron rm <id>`（别名：`remove`、`delete`）
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

所有 `cron` 命令接受 `--url`、`--token`、`--timeout`、`--expect-final`。

## 节点主机

`node` 运行**无头节点主机**或将其作为后台服务管理。参见 [`openclaw node`](/cli/node)。

子命令：

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## 节点

`nodes` 与 Gateway网关通信并操作已配对的节点。参见 [/nodes](/nodes)。

通用选项：

- `--url`、`--token`、`--timeout`、`--json`

子命令：

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>`（Mac 节点或无头节点主机）
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]`（仅限 Mac）

摄像头：

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

画布与屏幕：

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

位置：

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## 浏览器

浏览器控制 CLI（专用 Chrome/Brave/Edge/Chromium）。参见 [`openclaw browser`](/cli/browser) 和[浏览器工具](/tools/browser)。

通用选项：

- `--url`、`--token`、`--timeout`、`--json`
- `--browser-profile <name>`

管理：

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

检查：

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

操作：

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## 文档搜索

### `docs [query...]`

搜索在线文档索引。

## TUI

### `tui`

打开连接到 Gateway网关的终端 UI。

选项：

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>`（默认为 `agents.defaults.timeoutSeconds`）
- `--history-limit <n>`
