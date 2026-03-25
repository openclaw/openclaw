---
read_when:
  - 添加或修改 CLI 命令或选项时
  - 为新的命令界面编写文档时
summary: "`openclaw` 命令、子命令和选项的 OpenClaw CLI 参考"
title: CLI 参考
x-i18n:
  generated_at: "2026-03-16T06:22:35Z"
  model: gpt-5.4
  provider: openai
  source_hash: a2bca34fca64558a8d91fc640ad3880e79677e81d0f605083edc6cbe86bfba53
  source_path: cli/index.md
  workflow: 15
---

# CLI 参考

本页描述当前的 CLI 行为。如果命令发生变化，请更新此文档。

## 命令页面

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`completion`](/cli/completion)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`backup`](/cli/backup)
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
- [`directory`](/cli/directory)
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
- [`qr`](/cli/qr)
- [`plugins`](/cli/plugins)（插件命令）
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`secrets`](/cli/secrets)
- [`skills`](/cli/skills)
- [`daemon`](/cli/daemon)（Gateway 网关服务命令的旧别名）
- [`clawbot`](/cli/clawbot)（旧别名命名空间）
- [`voicecall`](/cli/voicecall)（插件；如已安装）

## 全局标志

- `--dev`：将状态隔离到 `~/.openclaw-dev` 下，并变更默认端口。
- `--profile <name>`：将状态隔离到 `~/.openclaw-<name>` 下。
- `--no-color`：禁用 ANSI 颜色。
- `--update`：`openclaw update` 的简写（仅适用于源码安装）。
- `-V`, `--version`, `-v`：打印版本并退出。

## 输出样式

- ANSI 颜色和进度指示器仅在 TTY 会话中渲染。
- OSC-8 超链接会在受支持的终端中显示为可点击链接；否则会回退为纯 URL。
- `--json`（以及在支持处的 `--plain`）会禁用样式，以获得干净输出。
- `--no-color` 会禁用 ANSI 样式；同时也支持 `NO_COLOR=1`。
- 长时间运行的命令会显示进度指示器（支持时使用 OSC 9;4）。

## 调色板

OpenClaw 在 CLI 输出中使用龙虾色调调色板。

- `accent` (#FF5A2D)：标题、标签、主要高亮。
- `accentBright` (#FF7A3D)：命令名称、强调。
- `accentDim` (#D14A22)：次级高亮文本。
- `info` (#FF8A5B)：信息性值。
- `success` (#2FBF71)：成功状态。
- `warn` (#FFB020)：警告、回退、注意事项。
- `error` (#E23D2D)：错误、失败。
- `muted` (#8B7F77)：弱化显示、元数据。

调色板唯一来源：`src/terminal/palette.ts`（也称为 “lobster seam”）。

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
  completion
  doctor
  dashboard
  backup
    create
    verify
  security
    audit
  secrets
    reload
    migrate
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
  directory
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
  daemon
    status
    install
    uninstall
    start
    stop
    restart
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
  qr
  clawbot
    qr
  docs
  dns
    setup
  tui
```

注意：插件可以添加额外的顶层命令（例如 `openclaw voicecall`）。

## 安全

- `openclaw security audit` — 审计配置 + 本地状态中常见的安全陷阱。
- `openclaw security audit --deep` — 尽力进行实时 Gateway 网关探测。
- `openclaw security audit --fix` — 收紧安全默认值并对状态 / 配置执行 chmod。

## 密钥

- `openclaw secrets reload` — 重新解析引用，并以原子方式替换运行时快照。
- `openclaw secrets audit` — 扫描明文残留、未解析引用和优先级漂移。
- `openclaw secrets configure` — 用于提供商设置 + SecretRef 映射 + 预检 / 应用的交互式助手。
- `openclaw secrets apply --from <plan.json>` — 应用先前生成的计划（支持 `--dry-run`）。

## 插件

管理扩展及其配置：

- `openclaw plugins list` — 发现插件（机器输出请使用 `--json`）。
- `openclaw plugins info <id>` — 显示插件详情。
- `openclaw plugins install <path|.tgz|npm-spec>` — 安装插件（或将插件路径添加到 `plugins.load.paths`）。
- `openclaw plugins enable <id>` / `disable <id>` — 切换 `plugins.entries.<id>.enabled`。
- `openclaw plugins doctor` — 报告插件加载错误。

大多数插件更改都需要重启 gateway。参见 [/plugin](/tools/plugin)。

## 内存

对 `MEMORY.md` + `memory/*.md` 执行向量搜索：

- `openclaw memory status` — 显示索引统计信息。
- `openclaw memory index` — 重新索引内存文件。
- `openclaw memory search "<query>"`（或 `--query "<query>"`）— 对内存执行语义搜索。

## 聊天斜杠命令

聊天消息支持 `/...` 命令（文本和原生）。参见 [/tools/slash-commands](/tools/slash-commands)。

重点：

- `/status` 用于快速诊断。
- `/config` 用于持久化配置更改。
- `/debug` 用于仅运行时的配置覆盖（内存中，不写磁盘；要求 `commands.debug: true`）。

## 设置 + 新手引导

### `setup`

初始化配置 + 工作区。

选项：

- `--workspace <dir>`：智能体工作区路径（默认 `~/.openclaw/workspace`）。
- `--wizard`：运行新手引导。
- `--non-interactive`：无提示运行新手引导。
- `--mode <local|remote>`：新手引导模式。
- `--remote-url <url>`：远程 Gateway 网关 URL。
- `--remote-token <token>`：远程 Gateway 网关 token。

只要存在任意新手引导标志（`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`），就会自动运行新手引导。

### `onboard`

用于设置 gateway、工作区和 Skills 的交互式新手引导。

选项：

- `--workspace <dir>`
- `--reset`（在运行新手引导前重置配置 + 凭据 + 会话）
- `--reset-scope <config|config+creds+sessions|full>`（默认 `config+creds+sessions`；使用 `full` 还会删除工作区）
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>`（`manual` 是 `advanced` 的别名）
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ollama|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|mistral-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|opencode-go|custom-api-key|skip>`
- `--token-provider <id>`（非交互式；与 `--auth-choice token` 一起使用）
- `--token <token>`（非交互式；与 `--auth-choice token` 一起使用）
- `--token-profile-id <id>`（非交互式；默认：`<provider>:manual`）
- `--token-expires-in <duration>`（非交互式；例如 `365d`、`12h`）
- `--secret-input-mode <plaintext|ref>`（默认 `plaintext`；使用 `ref` 可存储提供商默认环境引用，而非明文密钥）
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--mistral-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--opencode-go-api-key <key>`
- `--custom-base-url <url>`（非交互式；与 `--auth-choice custom-api-key` 或 `--auth-choice ollama` 一起使用）
- `--custom-model-id <id>`（非交互式；与 `--auth-choice custom-api-key` 或 `--auth-choice ollama` 一起使用）
- `--custom-api-key <key>`（非交互式；可选；与 `--auth-choice custom-api-key` 一起使用；省略时回退到 `CUSTOM_API_KEY`）
- `--custom-provider-id <id>`（非交互式；可选自定义提供商 id）
- `--custom-compatibility <openai|anthropic>`（非交互式；可选；默认 `openai`）
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-token-ref-env <name>`（非交互式；将 `gateway.auth.token` 存储为环境 SecretRef；要求该环境变量已设置；不能与 `--gateway-token` 一起使用）
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
- `--node-manager <npm|pnpm|bun>`（推荐 pnpm；不推荐将 bun 用作 Gateway 网关运行时）
- `--json`

### `configure`

交互式配置向导（模型、渠道、Skills、gateway）。

### `config`

非交互式配置助手（get/set/unset/file/validate）。直接运行 `openclaw config` 而不带
子命令会启动向导。

子命令：

- `config get <path>`：打印一个配置值（点 / 方括号路径）。
- `config set <path> <value>`：设置一个值（JSON5 或原始字符串）。
- `config unset <path>`：移除一个值。
- `config file`：打印当前活动配置文件路径。
- `config validate`：根据 schema 验证当前配置，而不启动 gateway。
- `config validate --json`：输出机器可读的 JSON。

### `doctor`

健康检查 + 快速修复（配置 + gateway + 旧版服务）。

选项：

- `--no-workspace-suggestions`：禁用工作区内存提示。
- `--yes`：接受默认值而不提示（无头）。
- `--non-interactive`：跳过提示；仅应用安全迁移。
- `--deep`：扫描系统服务以查找额外的 gateway 安装。

## 渠道助手

### `channels`

管理聊天渠道账户（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（插件）/Signal/iMessage/MS Teams）。

子命令：

- `channels list`：显示已配置的渠道和认证配置文件。
- `channels status`：检查 gateway 可达性和渠道健康状态（`--probe` 会运行额外检查；gateway 健康探测请使用 `openclaw health` 或 `openclaw status --deep`）。
- 提示：如果能够检测到常见配置错误，`channels status` 会打印带建议修复方式的警告（随后指向 `openclaw doctor`）。
- `channels logs`：显示 gateway 日志文件中的最近渠道日志。
- `channels add`：未传入任何标志时为向导式设置；传入标志后切换为非交互模式。
  - 当向仍使用单账户顶层配置的渠道添加非默认账户时，OpenClaw 会先将账户作用域值移动到 `channels.<channel>.accounts.default`，再写入新账户。
  - 非交互式 `channels add` 不会自动创建 / 升级绑定；仅渠道绑定会继续匹配默认账户。
- `channels remove`：默认执行禁用；传入 `--delete` 可在无提示下删除配置项。
- `channels login`：交互式渠道登录（仅 WhatsApp Web）。
- `channels logout`：登出某个渠道会话（如支持）。

通用选项：

- `--channel <name>`：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`：渠道账户 id（默认 `default`）
- `--name <label>`：账户显示名称

`channels login` 选项：

- `--channel <channel>`（默认 `whatsapp`；支持 `whatsapp`/`web`）
- `--account <id>`
- `--verbose`

`channels logout` 选项：

- `--channel <channel>`（默认 `whatsapp`）
- `--account <id>`

`channels list` 选项：

- `--no-usage`：跳过模型提供商用量 / 配额快照（仅 OAuth / API 支持）。
- `--json`：输出 JSON（除非设置了 `--no-usage`，否则包含用量）。

`channels logs` 选项：

- `--channel <name|all>`（默认 `all`）
- `--lines <n>`（默认 `200`）
- `--json`

更多细节：[/concepts/oauth](/concepts/oauth)

示例：

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

列出并检查可用 Skills，以及就绪信息。

子命令：

- `skills list`：列出 Skills（未指定子命令时的默认行为）。
- `skills info <name>`：显示单个 Skill 的详情。
- `skills check`：汇总已就绪与缺失的要求。

选项：

- `--eligible`：仅显示已就绪的 Skills。
- `--json`：输出 JSON（无样式）。
- `-v`, `--verbose`：包含缺失要求的详细信息。

提示：使用 `npx clawhub` 搜索、安装和同步 Skills。

### `pairing`

批准跨渠道的私信配对请求。

子命令：

- `pairing list [channel] [--channel <channel>] [--account <id>] [--json]`
- `pairing approve <channel> <code> [--account <id>] [--notify]`
- `pairing approve --channel <channel> [--account <id>] <code> [--notify]`

### `devices`

管理 gateway 设备配对条目和按角色划分的设备 token。

子命令：

- `devices list [--json]`
- `devices approve [requestId] [--latest]`
- `devices reject <requestId>`
- `devices remove <deviceId>`
- `devices clear --yes [--pending]`
- `devices rotate --device <id> --role <role> [--scope <scope...>]`
- `devices revoke --device <id> --role <role>`

### `webhooks gmail`

Gmail Pub/Sub hook 设置 + 运行器。参见 [/automation/gmail-pubsub](/automation/gmail-pubsub)。

子命令：

- `webhooks gmail setup`（要求 `--account <email>`；支持 `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`）
- `webhooks gmail run`（对相同标志进行运行时覆盖）

### `dns setup`

广域设备发现 DNS 助手（CoreDNS + Tailscale）。参见 [/gateway/discovery](/gateway/discovery)。

选项：

- `--apply`：安装 / 更新 CoreDNS 配置（需要 sudo；仅 macOS）。

## 消息 + 智能体

### `message`

统一的出站消息发送 + 渠道操作。

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

通过 Gateway 网关（或 `--local` 嵌入模式）运行一次智能体轮次。

必需项：

- `--message <text>`

选项：

- `--to <dest>`（用于会话键以及可选投递）
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>`（仅适用于 GPT-5.2 + Codex 模型）
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

添加一个新的隔离智能体。除非传入标志（或 `--non-interactive`），否则会运行引导式向导；在非交互模式下必须提供 `--workspace`。

选项：

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>`（可重复）
- `--non-interactive`
- `--json`

绑定规范使用 `channel[:accountId]`。省略 `accountId` 时，OpenClaw 可能通过渠道默认值 / 插件 hook 解析账户作用域；否则这就是不带显式账户作用域的渠道绑定。

#### `agents bindings`

列出路由绑定。

选项：

- `--agent <id>`
- `--json`

#### `agents bind`

为智能体添加路由绑定。

选项：

- `--agent <id>`
- `--bind <channel[:accountId]>`（可重复）
- `--json`

#### `agents unbind`

移除智能体的路由绑定。

选项：

- `--agent <id>`
- `--bind <channel[:accountId]>`（可重复）
- `--all`
- `--json`

#### `agents delete <id>`

删除一个智能体并清理其工作区 + 状态。

选项：

- `--force`
- `--json`

### `acp`

运行将 IDE 连接到 Gateway 网关的 ACP 桥接器。

完整选项和示例请参见 [`acp`](/cli/acp)。

### `status`

显示已链接会话的健康状态和最近收件人。

选项：

- `--json`
- `--all`（完整诊断；只读、可粘贴）
- `--deep`（探测渠道）
- `--usage`（显示模型提供商用量 / 配额）
- `--timeout <ms>`
- `--verbose`
- `--debug`（`--verbose` 的别名）

说明：

- 概览中会在可用时包含 Gateway 网关 + node host 服务状态。

### 用量跟踪

在 OAuth / API 凭据可用时，OpenClaw 可以显示提供商用量 / 配额。

展示位置：

- `/status`（可用时添加一行简短的提供商用量信息）
- `openclaw status --usage`（打印完整的提供商明细）
- macOS 菜单栏（Context 下的 Usage 部分）

说明：

- 数据直接来自提供商用量端点（不是估算值）。
- 提供商：Anthropic、GitHub Copilot、OpenAI Codex OAuth，以及打包的 `google` 插件所提供的 Gemini CLI 和在已配置情况下的 Antigravity。
- 如果不存在匹配的凭据，则不会显示用量。
- 详情：参见 [用量跟踪](/concepts/usage-tracking)。

### `health`

从运行中的 Gateway 网关获取健康状态。

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

## 重置 / 卸载

### `reset`

重置本地配置 / 状态（保留已安装的 CLI）。

选项：

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

说明：

- `--non-interactive` 要求同时提供 `--scope` 和 `--yes`。

### `uninstall`

卸载 gateway 服务 + 本地数据（CLI 保留）。

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

- `--non-interactive` 要求 `--yes` 和显式作用域（或 `--all`）。

## Gateway 网关

### `gateway`

运行 WebSocket Gateway 网关。

选项：

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--password-file <path>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset`（重置 dev 配置 + 凭据 + 会话 + 工作区）
- `--force`（杀掉端口上的现有监听器）
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact`（`--ws-log compact` 的别名）
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

管理 Gateway 网关服务（launchd/systemd/schtasks）。

子命令：

- `gateway status`（默认探测 Gateway 网关 RPC）
- `gateway install`（安装服务）
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

说明：

- `gateway status` 默认使用服务解析出的端口 / 配置来探测 Gateway 网关 RPC（可用 `--url/--token/--password` 覆盖）。
- `gateway status` 支持 `--no-probe`、`--deep`、`--require-rpc` 和 `--json`，便于脚本化。
- `gateway status` 还能在检测到时显示旧版或额外的 gateway 服务（`--deep` 会增加系统级扫描）。带 profile 名称的 OpenClaw 服务会被视为一等公民，不会标记为“额外”。
- `gateway status` 会打印 CLI 使用的是哪个配置路径、服务可能使用的是哪个配置（服务环境），以及解析出的探测目标 URL。
- 如果 gateway 认证 SecretRef 在当前命令路径中未解析，`gateway status --json` 仅会在探测连接 / 认证失败时报告 `rpc.authWarning`（探测成功时会抑制警告）。
- 在 Linux systemd 安装中，状态 token 漂移检查同时包括 `Environment=` 和 `EnvironmentFile=` 单元来源。
- `gateway install|uninstall|start|stop|restart` 支持 `--json`，便于脚本化（默认输出仍然更适合人类阅读）。
- `gateway install` 默认使用 Node 运行时；**不推荐** bun（存在 WhatsApp / Telegram bug）。
- `gateway install` 选项：`--port`、`--runtime`、`--token`、`--force`、`--json`。

### `logs`

通过 RPC 跟踪 Gateway 网关文件日志。

说明：

- TTY 会话会渲染彩色的结构化视图；非 TTY 会回退为纯文本。
- `--json` 会输出逐行 JSON（每行一个日志事件）。

示例：

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway 网关 CLI 助手（RPC 子命令可使用 `--url`、`--token`、`--password`、`--timeout`、`--expect-final`）。
当你传入 `--url` 时，CLI 不会自动应用配置或环境凭据。
请显式包含 `--token` 或 `--password`。缺少显式凭据会报错。

子命令：

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

常见 RPC：

- `config.apply`（验证 + 写入配置 + 重启 + 唤醒）
- `config.patch`（合并部分更新 + 重启 + 唤醒）
- `update.run`（运行更新 + 重启 + 唤醒）

提示：直接调用 `config.set`/`config.apply`/`config.patch` 时，如果配置已存在，请从
`config.get` 传入 `baseHash`。

## 模型

关于回退行为和扫描策略，请参见 [/concepts/models](/concepts/models)。

Anthropic setup-token（已支持）：

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

策略说明：这是技术兼容性。Anthropic 过去曾阻止某些
Claude Code 之外的订阅使用；在生产环境依赖 setup-token 之前，请确认当前的 Anthropic
条款。

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
- `--check`（退出码 1=已过期 / 缺失，2=即将过期）
- `--probe`（对已配置认证配置文件进行实时探测）
- `--probe-provider <name>`
- `--probe-profile <id>`（可重复或逗号分隔）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

始终包含认证总览以及认证存储中配置文件的 OAuth 过期状态。
`--probe` 会发起实时请求（可能消耗 token 并触发速率限制）。

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

- `add`：交互式认证助手
- `setup-token`：`--provider <name>`（默认 `anthropic`）、`--yes`
- `paste-token`：`--provider <name>`、`--profile-id <id>`、`--expires-in <duration>`

### `models auth order get|set|clear`

选项：

- `get`：`--provider <name>`、`--agent <id>`、`--json`
- `set`：`--provider <name>`、`--agent <id>`、`<profileIds...>`
- `clear`：`--provider <name>`、`--agent <id>`

## 系统

### `system event`

将一个系统事件加入队列，并可选择触发一次 heartbeat（Gateway 网关 RPC）。

必需项：

- `--text <text>`

选项：

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

heartbeat 控制（Gateway 网关 RPC）。

选项：

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

列出系统 presence 条目（Gateway 网关 RPC）。

选项：

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

管理计划任务（Gateway 网关 RPC）。参见 [/automation/cron-jobs](/automation/cron-jobs)。

子命令：

- `cron status [--json]`
- `cron list [--all] [--json]`（默认输出表格；原始输出请使用 `--json`）
- `cron add`（别名：`create`；要求 `--name`，并且必须且只能提供 `--at` | `--every` | `--cron` 之一，以及 `--system-event` | `--message` 之一作为负载）
- `cron edit <id>`（修补字段）
- `cron rm <id>`（别名：`remove`, `delete`）
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

所有 `cron` 命令都接受 `--url`、`--token`、`--timeout`、`--expect-final`。

## Node 主机

`node` 运行一个**无头 node host**，或将其作为后台服务进行管理。参见
[`openclaw node`](/cli/node)。

子命令：

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

认证说明：

- `node` 从环境 / 配置解析 gateway 认证（不支持 `--token`/`--password` 标志）：`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`，然后是 `gateway.auth.*`。在本地模式下，node host 会有意忽略 `gateway.remote.*`；在 `gateway.mode=remote` 时，`gateway.remote.*` 会根据远程优先级规则参与解析。
- 旧版 `CLAWDBOT_GATEWAY_*` 环境变量会被有意忽略，不用于 node-host 认证解析。

## Nodes

`nodes` 与 Gateway 网关通信，并以已配对节点为目标。参见 [/nodes](/nodes)。

通用选项：

- `--url`, `--token`, `--timeout`, `--json`

子命令：

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>`（mac 节点或无头 node host）
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]`（仅 mac）

相机：

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + 屏幕：

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

浏览器控制 CLI（专用 Chrome/Brave/Edge/Chromium）。参见 [`openclaw browser`](/cli/browser) 和 [Browser 工具](/tools/browser)。

通用选项：

- `--url`, `--token`, `--timeout`, `--json`
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

搜索实时文档索引。

## TUI

### `tui`

打开连接到 Gateway 网关的终端 UI。

选项：

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>`（默认值为 `agents.defaults.timeoutSeconds`）
- `--history-limit <n>`
