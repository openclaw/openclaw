---
summary: "OpenClaw CLI reference for `openclaw` commands, subcommands, and options"
read_when:
  - Adding or modifying CLI commands or options
  - Documenting new command surfaces
title: CLI Reference
---

# CLI 參考資料

此頁面描述了目前的 CLI 行為。如果指令有變更，請更新此文件。

## Command pages

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
- [`plugins`](/cli/plugins) (插件命令)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`secrets`](/cli/secrets)
- [`skills`](/cli/skills)
- [`daemon`](/cli/daemon) (舊版別名，用於網關服務命令)
- [`clawbot`](/cli/clawbot) (舊版別名命名空間)
- [`voicecall`](/cli/voicecall) (插件；如果已安裝)

## Global flags

- `--dev`: 在 `~/.openclaw-dev` 下隔離狀態並移動預設埠。
- `--profile <name>`: 在 `~/.openclaw-<name>` 下隔離狀態。
- `--no-color`: 禁用 ANSI 顏色。
- `--update`: `openclaw update` 的簡寫（僅限源碼安裝）。
- `-V`, `--version`, `-v`: 列印版本並退出。

## Output styling

- ANSI 顏色和進度指示器僅在 TTY 會話中顯示。
- OSC-8 超連結在支援的終端中顯示為可點擊的連結；否則我們會回退到純文字 URL。
- `--json`（以及在支援的情況下的 `--plain`）會禁用樣式以獲得乾淨的輸出。
- `--no-color` 禁用 ANSI 樣式；`NO_COLOR=1` 也會被尊重。
- 長時間執行的命令會顯示進度指示器（OSC 9;4 在支援的情況下）。

## 色彩調色盤

OpenClaw 使用龍蝦調色盤來顯示 CLI 輸出。

- `accent` (#FF5A2D): 標題、標籤、主要重點。
- `accentBright` (#FF7A3D): 命令名稱、強調。
- `accentDim` (#D14A22): 次要重點文字。
- `info` (#FF8A5B): 資訊值。
- `success` (#2FBF71): 成功狀態。
- `warn` (#FFB020): 警告、備援、注意事項。
- `error` (#E23D2D): 錯誤、失敗。
- `muted` (#8B7F77): 降低強調、元資料。

Palette source of truth: `src/terminal/palette.ts`（又稱「龍蝦接縫」）。

## Command tree

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

注意：插件可以添加額外的頂層命令（例如 `openclaw voicecall`）。

## Security

- `openclaw security audit` — 審計設定 + 本地狀態以防範常見的安全風險。
- `openclaw security audit --deep` — 最佳努力的即時 Gateway 探測。
- `openclaw security audit --fix` — 強化安全預設並調整狀態/設定的 chmod。

## Secrets

- `openclaw secrets reload` — 重新解析引用並原子性地交換執行時快照。
- `openclaw secrets audit` — 掃描明文殘留物、未解析的引用和優先順序漂移。
- `openclaw secrets configure` — 提供者設置的互動式助手 + SecretRef 映射 + 預檢/應用。
- `openclaw secrets apply --from <plan.json>` — 應用先前生成的計劃 (`--dry-run` 支援)。

## Plugins

管理擴充功能及其設定：

- `openclaw plugins list` — 發現插件（使用 `--json` 進行機器輸出）。
- `openclaw plugins info <id>` — 顯示插件的詳細資訊。
- `openclaw plugins install <path|.tgz|npm-spec>` — 安裝插件（或將插件路徑添加到 `plugins.load.paths`）。
- `openclaw plugins enable <id>` / `disable <id>` — 切換 `plugins.entries.<id>.enabled`。
- `openclaw plugins doctor` — 報告插件加載錯誤。

大多數插件變更需要重新啟動網關。請參見 [/plugin](/tools/plugin)。

## Memory

Vector search over `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — 顯示索引統計資訊。
- `openclaw memory index` — 重新索引記憶體檔案。
- `openclaw memory search "<query>"` (或 `--query "<query>"`) — 在記憶體上進行語意搜尋。

## 聊天斜線指令

聊天訊息支援 `/...` 指令（文字和原生）。請參見 [/tools/slash-commands](/tools/slash-commands)。

[[BLOCK_1]]

- `/status` 用於快速診斷。
- `/config` 用於持久化的設定變更。
- `/debug` 用於僅在執行時的設定覆蓋（記憶體，不是磁碟；需要 `commands.debug: true`）。

## Setup + onboarding

### `setup`

初始化設定 + 工作區。

Options:

- `--workspace <dir>`: 代理工作區路徑（預設 `~/.openclaw/workspace`）。
- `--wizard`: 執行入門精靈。
- `--non-interactive`: 無提示執行精靈。
- `--mode <local|remote>`: 精靈模式。
- `--remote-url <url>`: 遠端 Gateway URL。
- `--remote-token <token>`: 遠端 Gateway token。

當任何巫師標誌存在時，巫師會自動執行 (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`)。

### `onboard`

互動式精靈以設置網關、工作區和技能。

Options:

- `--workspace <dir>`
- `--reset` (在精靈之前重置設定 + 憑證 + 會話)
- `--reset-scope <config|config+creds+sessions|full>` (預設 `config+creds+sessions`; 使用 `full` 也可移除工作區)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual 是 advanced 的別名)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ollama|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|mistral-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|opencode-go|custom-api-key|skip>`
- `--token-provider <id>` (非互動式; 與 `--auth-choice token` 一起使用)
- `--token <token>` (非互動式; 與 `--auth-choice token` 一起使用)
- `--token-profile-id <id>` (非互動式; 預設: `<provider>:manual`)
- `--token-expires-in <duration>` (非互動式; 例如 `365d`, `12h`)
- `--secret-input-mode <plaintext|ref>` (預設 `plaintext`; 使用 `ref` 以儲存提供者的預設環境參考，而不是明文金鑰)
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
- `--custom-base-url <url>` (非互動式; 與 `--auth-choice custom-api-key` 或 `--auth-choice ollama` 一起使用)
- `--custom-model-id <id>` (非互動式; 與 `--auth-choice custom-api-key` 或 `--auth-choice ollama` 一起使用)
- `--custom-api-key <key>` (非互動式; 可選; 與 `--auth-choice custom-api-key` 一起使用; 當省略時回退到 `CUSTOM_API_KEY`)
- `--custom-provider-id <id>` (非互動式; 可選的自定義提供者 ID)
- `--custom-compatibility <openai|anthropic>` (非互動式; 可選; 預設 `openai`)
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-token-ref-env <name>` (非互動式; 將 `gateway.auth.token` 儲存為環境 SecretRef; 需要設置該環境變數; 不能與 `--gateway-token` 組合使用)
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (別名: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (推薦使用 pnpm; 不建議在 Gateway 執行時使用 bun)
- `--json`

### `configure`

互動式設定精靈（模型、通道、技能、網關）。

### `config`

非互動式設定助手（獲取/設置/取消設置/文件/驗證）。執行 `openclaw config` 而不帶子命令將啟動精靈。

Subcommands:

- `config get <path>`: 列印設定值（點/括號路徑）。
- `config set <path> <value>`: 設定一個值（JSON5 或原始字串）。
- `config unset <path>`: 移除一個值。
- `config file`: 列印當前的設定檔案路徑。
- `config validate`: 在不啟動網關的情況下，驗證當前設定是否符合架構。
- `config validate --json`: 輸出機器可讀的 JSON 格式。

### `doctor`

健康檢查 + 快速修復（設定 + 閘道 + 遺留服務）。

Options:

- `--no-workspace-suggestions`: 禁用工作區記憶提示。
- `--yes`: 在不提示的情況下接受預設值（無頭模式）。
- `--non-interactive`: 跳過提示；僅應用安全遷移。
- `--deep`: 掃描系統服務以查找額外的網關安裝。

## Channel helpers

### `channels`

管理聊天頻道帳戶（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（插件）/Signal/iMessage/MS Teams）。

[[BLOCK_1]]  
Subcommands:  
[[BLOCK_1]]

- `channels list`: 顯示已設定的通道和認證設定檔。
- `channels status`: 檢查網關可達性和通道健康狀況 (`--probe` 進行額外檢查；使用 `openclaw health` 或 `openclaw status --deep` 進行網關健康探測)。
- 提示: `channels status` 在檢測到常見的錯誤設定時會列印警告並提供建議的修正（然後指向 `openclaw doctor`）。
- `channels logs`: 從網關日誌檔案顯示最近的通道日誌。
- `channels add`: 當未傳遞任何標誌時，使用向導式設置；標誌切換到非互動模式。
  - 當將非預設帳戶添加到仍使用單帳戶頂層設定的通道時，OpenClaw 會在寫入新帳戶之前將帳戶範圍的值移入 `channels.<channel>.accounts.default`。
  - 非互動的 `channels add` 不會自動創建/升級綁定；僅通道的綁定將繼續匹配預設帳戶。
- `channels remove`: 預設禁用；傳遞 `--delete` 以在不提示的情況下移除設定條目。
- `channels login`: 互動式通道登入（僅限 WhatsApp Web）。
- `channels logout`: 登出通道會話（如果支援）。

常見選項：

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: 頻道帳戶 ID（預設 `default`）
- `--name <label>`: 帳戶的顯示名稱

`channels login` 選項：

- `--channel <channel>` (預設 `whatsapp`; 支援 `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

`channels logout` 選項：

- `--channel <channel>` (預設 `whatsapp`)
- `--account <id>`

`channels list` 選項：

- `--no-usage`: 跳過模型提供者的使用/配額快照（僅限於 OAuth/API 支援）。
- `--json`: 輸出 JSON（包括使用情況，除非設定 `--no-usage`）。

`channels logs` 選項：

- `--channel <name|all>` (預設 `all`)
- `--lines <n>` (預設 `200`)
- `--json`

More detail: [/concepts/oauth](/concepts/oauth)

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

列出並檢查可用的技能及準備狀態資訊。

[[BLOCK_1]]  
子指令：  
[[BLOCK_1]]

- `skills list`: 列出技能（當沒有子指令時的預設行為）。
- `skills info <name>`: 顯示某項技能的詳細資訊。
- `skills check`: 已準備與缺失需求的摘要。

Options:

- `--eligible`: 僅顯示已準備好的技能。
- `--json`: 輸出 JSON（無樣式）。
- `-v`, `--verbose`: 包含缺失要求的詳細資訊。

提示：使用 `npx clawhub` 來搜尋、安裝和同步技能。

### `pairing`

批准跨渠道的 DM 配對請求。

Subcommands:

- `pairing list [channel] [--channel <channel>] [--account <id>] [--json]`
- `pairing approve <channel> <code> [--account <id>] [--notify]`
- `pairing approve --channel <channel> [--account <id>] <code> [--notify]`

### `devices`

管理閘道裝置配對條目和每個角色的裝置 token。

Subcommands:

- `devices list [--json]`
- `devices approve [requestId] [--latest]`
- `devices reject <requestId>`
- `devices remove <deviceId>`
- `devices clear --yes [--pending]`
- `devices rotate --device <id> --role <role> [--scope <scope...>]`
- `devices revoke --device <id> --role <role>`

### `webhooks gmail`

Gmail Pub/Sub 鉤子設置 + 執行器。請參見 [/automation/gmail-pubsub](/automation/gmail-pubsub)。

Subcommands:

- `webhooks gmail setup`（需要 `--account <email>`；支援 `--project`、`--topic`、`--subscription`、`--label`、`--hook-url`、`--hook-token`、`--push-token`、`--bind`、`--port`、`--path`、`--include-body`、`--max-bytes`、`--renew-minutes`、`--tailscale`、`--tailscale-path`、`--tailscale-target`、`--push-endpoint`、`--json`）
- `webhooks gmail run`（相同標誌的執行時覆蓋）

### `dns setup`

廣域發現 DNS 幫助程式（CoreDNS + Tailscale）。請參見 [/gateway/discovery](/gateway/discovery)。

Options:

- `--apply`: 安裝/更新 CoreDNS 設定（需要 sudo；僅限 macOS）。

## Messaging + agent

### `message`

統一的外發訊息 + 通道操作。

看：[/cli/message](/cli/message)

Subcommands:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

[[BLOCK_1]]  
範例：  
[[BLOCK_2]]

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

透過 Gateway 執行一個代理回合（或 `--local` 嵌入式）。

[[BLOCK_1]]

`--message <text>`

Options:

- `--to <dest>` (用於會話金鑰和可選的交付)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (僅限 GPT-5.2 + Codex 模型)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

管理獨立代理（工作區 + 認證 + 路由）。

#### `agents list`

列出已設定的代理。

Options:

- `--json`
- `--bindings`

#### `agents add [name]`

新增一個獨立的代理。除非傳遞標誌 (或 `--non-interactive`)，否則將執行引導式精靈；在非互動模式下，`--workspace` 是必需的。

Options:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (repeatable)
- `--non-interactive`
- `--json`

綁定規範使用 `channel[:accountId]`。當 `accountId` 被省略時，OpenClaw 可能會透過通道預設值/插件鉤子來解析帳戶範圍；否則，它是一個沒有明確帳戶範圍的通道綁定。

#### `agents bindings`

[[BLOCK_1]]  
列出路由綁定。  
[[BLOCK_1]]

Options:

- `--agent <id>`
- `--json`

#### `agents bind`

為代理添加路由綁定。

Options:

- `--agent <id>`
- `--bind <channel[:accountId]>` (可重複)
- `--json`

#### `agents unbind`

移除代理的路由綁定。

Options:

- `--agent <id>`
- `--bind <channel[:accountId]>` (可重複)
- `--all`
- `--json`

#### `agents delete <id>`

刪除一個代理並修剪其工作區和狀態。

Options:

- `--force`
- `--json`

### `acp`

執行連接 IDE 與 Gateway 的 ACP 橋接。

請參閱 [`acp`](/cli/acp) 以獲取完整的選項和範例。

### `status`

顯示連結的會話健康狀態和最近的接收者。

Options:

- `--json`
- `--all` (完整診斷；唯讀，可貼上)
- `--deep` (探測通道)
- `--usage` (顯示模型提供者使用情況/配額)
- `--timeout <ms>`
- `--verbose`
- `--debug` (`--verbose` 的別名)

[[BLOCK_1]]

- 概述包括閘道器 + 節點主機服務狀態（當可用時）。

### 使用追蹤

OpenClaw 可以在有 OAuth/API 憑證的情況下顯示供應商的使用情況/配額。

[[BLOCK_1]]

- `/status` (當可用時，添加一行簡短的提供者使用情況)
- `openclaw status --usage` (列印完整的提供者詳細資訊)
- macOS 選單列 (上下文中的使用情況部分)

[[BLOCK_1]]

- 數據直接來自提供者的使用端點（無估算）。
- 提供者：Anthropic、GitHub Copilot、OpenAI Codex OAuth，以及當這些提供者插件啟用時的 Gemini CLI/Antigravity。
- 如果不存在匹配的憑證，則使用情況將被隱藏。
- 詳情：請參見 [Usage tracking](/concepts/usage-tracking)。

### `health`

從正在執行的 Gateway 獲取健康狀態。

Options:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

列出儲存的對話會話。

Options:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Reset / Uninstall

### `reset`

重置本地設定/狀態（保留已安裝的 CLI）。

Options:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

[[BLOCK_1]]

- `--non-interactive` 需要 `--scope` 和 `--yes`。

### `uninstall`

卸載網關服務 + 本地數據（CLI 保留）。

Options:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

[[BLOCK_1]]

- `--non-interactive` 需要 `--yes` 和明確的範圍 (或 `--all`)。

## Gateway

### `gateway`

執行 WebSocket 閘道。

Options:

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
- `--reset` (重置開發設定 + 憑證 + 會話 + 工作區)
- `--force` (終止在端口上的現有監聽器)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (`--ws-log compact` 的別名)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

管理 Gateway 服務（launchd/systemd/schtasks）。

[[BLOCK_1]]

- `gateway status`（預設探測 Gateway RPC）
- `gateway install`（服務安裝）
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

[[BLOCK_1]]

- `gateway status` 預設透過服務解析的端口/設定來探測 Gateway RPC（可用 `--url/--token/--password` 進行覆蓋）。
- `gateway status` 支援 `--no-probe`、`--deep` 和 `--json` 進行腳本編寫。
- `gateway status` 也會在能夠檢測到時顯示舊版或額外的網關服務（`--deep` 會添加系統級掃描）。以設定檔命名的 OpenClaw 服務被視為一級服務，並不會被標記為「額外」。
- `gateway status` 列印 CLI 使用的設定路徑與服務可能使用的設定（服務環境），以及解析的探測目標 URL。
- 在 Linux systemd 安裝中，狀態 token-drift 檢查包括 `Environment=` 和 `EnvironmentFile=` 單元來源。
- `gateway install|uninstall|start|stop|restart` 支援 `--json` 進行腳本編寫（預設輸出保持人性化）。
- `gateway install` 預設為 Node 執行環境；不建議使用 bun（WhatsApp/Telegram 錯誤）。
- `gateway install` 選項：`--port`、`--runtime`、`--token`、`--force`、`--json`。

### `logs`

透過 RPC 監控 Tail Gateway 檔案日誌。

[[BLOCK_1]]

- TTY 會話呈現彩色化的結構化視圖；非 TTY 則回退為純文字。
- `--json` 會輸出以行為分隔的 JSON（每行一個日誌事件）。

[[BLOCK_1]]  
Examples:  
[[INLINE_1]]

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI 幫助工具（使用 `--url`、`--token`、`--password`、`--timeout`、`--expect-final` 來執行 RPC 子命令）。當你傳遞 `--url` 時，CLI 不會自動應用設定或環境憑證。請明確包含 `--token` 或 `--password`。缺少明確的憑證將會導致錯誤。

[[BLOCK_1]]

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

[[BLOCK_1]]  
Common RPCs:  
[[BLOCK_1]]

- `config.apply` (驗證 + 寫入設定 + 重啟 + 喚醒)
- `config.patch` (合併部分更新 + 重啟 + 喚醒)
- `update.run` (執行更新 + 重啟 + 喚醒)

提示：當直接呼叫 `config.set`/`config.apply`/`config.patch` 時，如果已經存在設定，請從 `config.get` 傳遞 `baseHash`。

## Models

請參閱 [/concepts/models](/concepts/models) 以了解回退行為和掃描策略。

[[BLOCK_1]]  
Anthropic setup-token (supported):  
[[BLOCK_1]]

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

政策說明：這是技術相容性。Anthropic 過去曾阻止某些訂閱在 Claude Code 之外的使用；在生產環境中依賴 setup-token 之前，請確認當前的 Anthropic 條款。

### `models` (root)

`openclaw models` 是 `models status` 的別名。

Root options:

- `--status-json` (`models status --json` 的別名)
- `--status-plain` (`models status --plain` 的別名)

### `models list`

Options:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

[[BLOCK_1]]

- `--json`
- `--plain`
- `--check` (退出 1=過期/缺失, 2=即將過期)
- `--probe` (已設定的認證檔案的即時探測)
- `--probe-provider <name>`
- `--probe-profile <id>` (重複或以逗號分隔)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

始終包括身份驗證概述和身份驗證存儲中設定檔的 OAuth 到期狀態。  
`--probe` 執行即時請求（可能會消耗 token 並觸發速率限制）。

### `models set <model>`

Set `agents.defaults.model.primary`.

### `models set-image <model>`

Set `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Options:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Options:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Options:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Options:

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

Options:

- `add`: 互動式認證助手
- `setup-token`: `--provider <name>` (預設 `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Options:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

將系統事件排入佇列，並可選擇觸發心跳（Gateway RPC）。

[[BLOCK_1]]

`--text <text>`

Options:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat 控制 (Gateway RPC)。

Options:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

列出系統存在條目（Gateway RPC）。

Options:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

管理排程工作（Gateway RPC）。請參見 [/automation/cron-jobs](/automation/cron-jobs)。

Subcommands:

- `cron status [--json]`
- `cron list [--all] [--json]`（預設為表格輸出；使用 `--json` 以獲取原始數據）
- `cron add`（別名：`create`；需要 `--name` 和恰好一個 `--at` | `--every` | `--cron`，以及恰好一個有效載荷 `--system-event` | `--message`）
- `cron edit <id>`（修補欄位）
- `cron rm <id>`（別名：`remove`，`delete`）
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

所有 `cron` 指令都接受 `--url`、`--token`、`--timeout`、`--expect-final`。

## Node host

`node` 執行一個 **無頭節點主機** 或將其作為背景服務管理。請參見 `openclaw node`(/cli/node)。

[[BLOCK_1]]  
Subcommands:  
[[BLOCK_1]]

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

Auth notes:

- `node` 從環境/設定中解析閘道認證 (不使用 `--token`/`--password` 標誌)：`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`，然後 `gateway.auth.*`。在本地模式下，節點主機故意忽略 `gateway.remote.*`；在 `gateway.mode=remote` 中，`gateway.remote.*` 根據遠端優先規則參與。
- 過時的 `CLAWDBOT_GATEWAY_*` 環境變數在節點主機認證解析中被故意忽略。

## Nodes

`nodes` 與 Gateway 進行通訊並針對配對的節點。請參見 [/nodes](/nodes)。

常見選項：

- `--url`, `--token`, `--timeout`, `--json`

[[BLOCK_1]]

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac 節點或無頭節點主機)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (僅限 mac)

Camera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + screen:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

[[BLOCK_1]]

`nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Browser

Browser control CLI（專用於 Chrome/Brave/Edge/Chromium）。請參見 [`openclaw browser`](/cli/browser) 和 [Browser tool](/tools/browser)。

常見選項：

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Manage:

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

Inspect:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Actions:

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

## Docs search

### `docs [query...]`

搜尋即時文件索引。

## TUI

### `tui`

打開連接到 Gateway 的終端 UI。

Options:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (預設為 `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
