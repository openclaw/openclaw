---
summary: "OpenClaw CLI reference for `openclaw` commands, subcommands, and options"
read_when:
  - Adding or modifying CLI commands or options
  - Documenting new command surfaces
title: CLI Reference
---

# CLI 參考手冊

本頁說明目前 CLI 的行為。如指令有變更，請更新此文件。

## 指令頁面

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
- [`plugins`](/cli/plugins) (外掛指令)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`secrets`](/cli/secrets)
- [`skills`](/cli/skills)
- [`daemon`](/cli/daemon) (舊版 gateway 服務指令別名)
- [`clawbot`](/cli/clawbot) (舊版別名命名空間)
- [`voicecall`](/cli/voicecall) (外掛；若已安裝)

## 全域旗標

- `--dev`：在 `~/.openclaw-dev` 下隔離狀態並調整預設埠號。
- `--profile <name>`：在 `~/.openclaw-<name>` 下隔離狀態。
- `--no-color`：停用 ANSI 顏色。
- `--update`：`openclaw update` 的簡寫（僅限原始碼安裝）。
- `-V`、`--version`、`-v`：顯示版本並退出。

## 輸出樣式

- ANSI 顏色與進度指示器僅在 TTY 會話中顯示。
- OSC-8 超連結在支援的終端機中會呈現為可點擊連結；否則會退回顯示純文字 URL。
- `--json`（以及支援時的 `--plain`）會停用樣式以輸出乾淨內容。
- `--no-color` 停用 ANSI 樣式；`NO_COLOR=1` 也會被遵守。
- 長時間執行的指令會顯示進度指示器（支援時為 OSC 9;4）。

## 色彩調色盤

OpenClaw 使用龍蝦色調作為 CLI 輸出色彩調色盤。

- `accent` (#FF5A2D)：標題、標籤、主要重點。
- `accentBright` (#FF7A3D)：指令名稱、強調。
- `accentDim` (#D14A22)：次要重點文字。
- `info` (#FF8A5B)：資訊數值。
- `success` (#2FBF71)：成功狀態。
- `warn` (#FFB020)：警告、備用方案、注意事項。
- `error` (#E23D2D)：錯誤、失敗。
- `muted` (#8B7F77)：弱化、元資料。

調色盤的真實來源：`src/terminal/palette.ts`（又稱「龍蝦接縫」）。

## 指令樹

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

注意：外掛可以新增額外的頂層指令（例如 `openclaw voicecall`）。

## 安全性

- `openclaw security audit` — 審核設定與本地狀態，以防止常見的安全陷阱。
- `openclaw security audit --deep` — 盡力進行即時 Gateway 探測。
- `openclaw security audit --fix` — 強化安全預設值並調整狀態/設定檔的權限。

## 機密資訊

- `openclaw secrets reload` — 重新解析參考並原子性地交換執行時快照。
- `openclaw secrets audit` — 掃描明文殘留、未解析的參考與優先權漂移。
- `openclaw secrets configure` — 互動式協助工具，用於提供者設定、SecretRef 映射及預檢/套用。
- `openclaw secrets apply --from <plan.json>` — 套用先前產生的計劃（`--dry-run` 支援）。

## 外掛程式

管理擴充功能及其設定：

- `openclaw plugins list` — 探索外掛（機器輸出請使用 `--json`）。
- `openclaw plugins info <id>` — 顯示外掛詳細資訊。
- `openclaw plugins install <path|.tgz|npm-spec>` — 安裝外掛（或將外掛路徑加入 `plugins.load.paths`）。
- `openclaw plugins enable <id>` / `disable <id>` — 切換 `plugins.entries.<id>.enabled`。
- `openclaw plugins doctor` — 回報外掛載入錯誤。

大多數外掛變更需要重新啟動閘道。詳見 [/plugin](/tools/plugin)。

## 記憶體

針對 `MEMORY.md` + `memory/*.md` 進行向量搜尋：

- `openclaw memory status` — 顯示索引統計資料。
- `openclaw memory index` — 重新建立記憶檔案索引。
- `openclaw memory search "<query>"`（或 `--query "<query>"`）— 對記憶進行語意搜尋。

## 聊天斜線指令

聊天訊息支援 `/...` 指令（文字與原生指令）。詳見 [/tools/slash-commands](/tools/slash-commands)。

重點：

- `/status` 用於快速診斷。
- `/config` 用於持久化設定變更。
- `/debug` 用於僅限執行時的設定覆寫（記憶體中，不寫入磁碟；需 `commands.debug: true`）。

## 設定與入門

### `setup`

初始化設定與工作區。

選項：

- `--workspace <dir>`：代理工作區路徑（預設 `~/.openclaw/workspace`）。
- `--wizard`：執行入門精靈。
- `--non-interactive`：無提示執行精靈。
- `--mode <local|remote>`：精靈模式。
- `--remote-url <url>`：遠端 Gateway URL。
- `--remote-token <token>`：遠端 Gateway token。

當存在任何 wizard 標誌時，wizard 會自動執行 (`--non-interactive`、`--mode`、`--remote-url`、`--remote-token`)。

### `onboard`

互動式 wizard 用於設定 gateway、workspace 及技能。

選項：

- `--workspace <dir>`
- `--reset`（在 wizard 之前重置設定、憑證及會話）
- `--reset-scope <config|config+creds+sessions|full>`（預設 `config+creds+sessions`；使用 `full` 也會移除 workspace）
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>`（manual 是 advanced 的別名）
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ollama|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|mistral-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|opencode-go|custom-api-key|skip>`
- `--token-provider <id>`（非互動式；與 `--auth-choice token` 一起使用）
- `--token <token>`（非互動式；與 `--auth-choice token` 一起使用）
- `--token-profile-id <id>`（非互動式；預設：`<provider>:manual`）
- `--token-expires-in <duration>`（非互動式；例如 `365d`、`12h`）
- `--secret-input-mode <plaintext|ref>`（預設 `plaintext`；使用 `ref` 以儲存提供者預設的環境參考，而非明文金鑰）
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
- `--custom-base-url <url>`（非互動式；與 `--auth-choice custom-api-key` 或 `--auth-choice ollama` 一起使用）
- `--custom-model-id <id>`（非互動式；與 `--auth-choice custom-api-key` 或 `--auth-choice ollama` 一起使用）
- `--custom-api-key <key>`（非互動式；可選；與 `--auth-choice custom-api-key` 一起使用；省略時回退至 `CUSTOM_API_KEY`）
- `--custom-provider-id <id>`（非互動式；可選自訂提供者 ID）
- `--custom-compatibility <openai|anthropic>`（非互動式；可選；預設 `openai`）
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-token-ref-env <name>`（非互動式；將 `gateway.auth.token` 儲存為環境 SecretRef；需先設定該環境變數；不可與 `--gateway-token` 一起使用）
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon`（別名：`--skip-daemon`）
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>`（推薦使用 pnpm；不建議用 bun 作為 Gateway 執行環境）
- `--json`

### `configure`

互動式設定精靈（模型、頻道、技能、閘道）。

### `config`

非互動式設定輔助工具（取得/設定/取消設定/檔案/驗證）。執行 `openclaw config` 且未帶子指令時，會啟動設定精靈。

子指令：

- `config get <path>`：列印設定值（點號/括號路徑）。
- `config set <path> <value>`：設定一個值（JSON5 或原始字串）。
- `config unset <path>`：移除一個值。
- `config file`：列印目前啟用的設定檔路徑。
- `config validate`：在不啟動 gateway 的情況下，驗證目前設定是否符合 schema。
- `config validate --json`：輸出機器可讀的 JSON 格式。

### `doctor`

健康檢查 + 快速修復（設定 + gateway + 舊版服務）。

選項：

- `--no-workspace-suggestions`：停用工作區記憶體提示。
- `--yes`：接受預設值且不提示（無頭模式）。
- `--non-interactive`：跳過提示；僅套用安全的遷移。
- `--deep`：掃描系統服務以尋找額外的 gateway 安裝。

## 頻道輔助工具

### `channels`

管理聊天頻道帳號（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（外掛）/Signal/iMessage/MS Teams）。

子指令：

- `channels list`：顯示已設定的頻道與認證設定檔。
- `channels status`：檢查閘道可達性與頻道健康狀態（`--probe` 執行額外檢查；使用 `openclaw health` 或 `openclaw status --deep` 進行閘道健康探測）。
- 提示：`channels status` 在偵測到常見錯誤設定時會列印警告並建議修正方法（接著會指引你到 `openclaw doctor`）。
- `channels logs`：顯示閘道日誌檔案中的近期頻道日誌。
- `channels add`：當未帶任何參數時以精靈模式設定；帶參數則切換為非互動模式。
  - 當向仍使用單一帳號頂層設定的頻道新增非預設帳號時，OpenClaw 會先將帳號範圍的設定值移入 `channels.<channel>.accounts.default`，然後再寫入新帳號。
  - 非互動模式的 `channels add` 不會自動建立或升級綁定；僅頻道綁定會繼續匹配預設帳號。
- `channels remove`：預設為停用；傳入 `--delete` 可在不提示的情況下移除設定專案。
- `channels login`：互動式頻道登入（僅限 WhatsApp Web）。
- `channels logout`：登出頻道會話（若支援）。

常用選項：

- `--channel <name>`：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`：頻道帳號 ID（預設 `default`）
- `--name <label>`：帳號顯示名稱

`channels login` 選項：

- `--channel <channel>`（預設 `whatsapp`；支援 `whatsapp`/`web`）
- `--account <id>`
- `--verbose`

`channels logout` 選項：

- `--channel <channel>`（預設 `whatsapp`）
- `--account <id>`

`channels list` 選項：

- `--no-usage`：跳過模型提供者的使用量/配額快照（僅限 OAuth/API 支援）。
- `--json`：輸出 JSON（包含使用量，除非設定了 `--no-usage`）。

`channels logs` 選項：

- `--channel <name|all>`（預設 `all`）
- `--lines <n>`（預設 `200`）
- `--json`

更多細節：[/concepts/oauth](/concepts/oauth)

範例：

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

列出並檢視可用技能及準備狀態資訊。

子指令：

- `skills list`：列出技能（無子指令時的預設動作）。
- `skills info <name>`：顯示單一技能的詳細資訊。
- `skills check`：已準備與缺少需求的摘要。

選項：

- `--eligible`：僅顯示已準備的技能。
- `--json`：輸出 JSON（無格式化）。
- `-v`、`--verbose`：包含缺少需求的詳細資訊。

提示：使用 `npx clawhub` 來搜尋、安裝及同步技能。

### `pairing`

在多個頻道中批准私訊配對請求。

子指令：

- `pairing list [channel] [--channel <channel>] [--account <id>] [--json]`
- `pairing approve <channel> <code> [--account <id>] [--notify]`
- `pairing approve --channel <channel> [--account <id>] <code> [--notify]`

### `devices`

管理閘道裝置配對條目及每個角色的裝置 token。

子指令：

- `devices list [--json]`
- `devices approve [requestId] [--latest]`
- `devices reject <requestId>`
- `devices remove <deviceId>`
- `devices clear --yes [--pending]`
- `devices rotate --device <id> --role <role> [--scope <scope...>]`
- `devices revoke --device <id> --role <role>`

### `webhooks gmail`

Gmail Pub/Sub 鉤子設定與執行器。詳見 [/automation/gmail-pubsub](/automation/gmail-pubsub)。

子指令：

- `webhooks gmail setup`（需要 `--account <email>`；支援 `--project`、`--topic`、`--subscription`、`--label`、`--hook-url`、`--hook-token`、`--push-token`、`--bind`、`--port`、`--path`、`--include-body`、`--max-bytes`、`--renew-minutes`、`--tailscale`、`--tailscale-path`、`--tailscale-target`、`--push-endpoint`、`--json`)
- `webhooks gmail run`（相同旗標的執行時覆寫）

### `dns setup`

廣域網路發現 DNS 輔助工具（CoreDNS + Tailscale）。詳見 [/gateway/discovery](/gateway/discovery)。

選項：

- `--apply`：安裝/更新 CoreDNS 設定（需要 sudo 權限；僅限 macOS）。

## 訊息傳遞 + 代理程式

### `message`

統一的外發訊息與頻道操作。

參見：[/cli/message](/cli/message)

子指令：

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

範例：

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

透過 Gateway（或 `--local` 內嵌）執行一次代理回合。

必填：

- `--message <text>`

選項：

- `--to <dest>`（用於會話金鑰及選擇性傳遞）
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>`（僅限 GPT-5.2 + Codex 模型）
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

選項：

- `--json`
- `--bindings`

#### `agents add [name]`

新增一個獨立代理。除非有傳入參數（或 `--non-interactive`），否則會執行引導式精靈；非互動模式下必須提供 `--workspace`。

選項：

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>`（可重複）
- `--non-interactive`
- `--json`

Binding 規格使用 `channel[:accountId]`。當省略 `accountId` 時，OpenClaw 可能會透過頻道預設值或外掛鉤子解析帳戶範圍；否則，這是一個沒有明確帳戶範圍的頻道綁定。

#### `agents bindings`

列出路由綁定。

選項：

- `--agent <id>`
- `--json`

#### `agents bind`

為代理新增路由綁定。

選項：

- `--agent <id>`
- `--bind <channel[:accountId]>`（可重複）
- `--json`

#### `agents unbind`

移除代理的路由綁定。

選項：

- `--agent <id>`
- `--bind <channel[:accountId]>`（可重複）
- `--all`
- `--json`

#### `agents delete <id>`

刪除代理並清理其工作區與狀態。

選項：

- `--force`
- `--json`

### `acp`

執行連接 IDE 與 Gateway 的 ACP 橋接程式。

完整選項與範例請參考 [`acp`](/cli/acp)。

### `status`

顯示連結會話的健康狀態及近期收件人。

選項：

- `--json`
- `--all`（完整診斷；唯讀，可貼上）
- `--deep`（探測通道）
- `--usage`（顯示模型提供者使用情況/配額）
- `--timeout <ms>`
- `--verbose`
- `--debug`（`--verbose` 的別名）

備註：

- 概覽包含 Gateway + 節點主機服務狀態（若可用）。

### 使用量追蹤

當有 OAuth/API 憑證時，OpenClaw 可以顯示提供者的使用量/配額。

顯示專案：

- `/status`（有提供時會新增簡短的提供者使用量行）
- `openclaw status --usage`（列印完整的提供者明細）
- macOS 功能表列（Context 下的使用量區段）

備註：

- 資料直接來自提供者的使用端點（無估算值）。
- 提供者：Anthropic、GitHub Copilot、OpenAI Codex OAuth，以及在啟用相應提供者外掛時的 Gemini CLI/Antigravity。
- 若無相符的憑證，使用情況將被隱藏。
- 詳情請參考 [使用追蹤](/concepts/usage-tracking)。

### `health`

從正在執行的 Gateway 取得健康狀態。

選項：

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

列出已儲存的對話會話。

選項：

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## 重置 / 卸載

### `reset`

重置本地設定/狀態（保留已安裝的 CLI）。

選項：

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

備註：

- `--non-interactive` 需要 `--scope` 和 `--yes`。

### `uninstall`

解除安裝閘道服務及本地資料（CLI 保留）。

選項：

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

備註：

- `--non-interactive` 需要 `--yes` 以及明確的權限範圍（或 `--all`）。

## Gateway

### `gateway`

啟動 WebSocket Gateway。

選項：

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
- `--reset`（重置開發設定 + 憑證 + 會話 + 工作區）
- `--force`（終止該埠口上現有的監聽程序）
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact`（`--ws-log compact` 的別名）
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

管理 Gateway 服務（launchd/systemd/schtasks）。

子指令：

- `gateway status`（預設探測 Gateway RPC）
- `gateway install`（服務安裝）
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

注意事項：

- `gateway status` 預設使用服務解析後的埠號/設定來探測 Gateway RPC（可用 `--url/--token/--password` 覆寫）。
- `gateway status` 支援 `--no-probe`、`--deep` 和 `--json` 以便腳本化操作。
- `gateway status` 也會在能偵測到時顯示舊版或額外的 gateway 服務（`--deep` 新增系統層級掃描）。以 Profile 命名的 OpenClaw 服務被視為一級服務，不會被標記為「額外」。
- `gateway status` 會列印 CLI 使用的設定路徑與服務可能使用的設定（服務環境變數），以及解析後的探測目標 URL。
- 在 Linux systemd 安裝中，狀態 token-drift 檢查包含 `Environment=` 和 `EnvironmentFile=` 兩種單元來源。
- `gateway install|uninstall|start|stop|restart` 支援 `--json` 以便腳本化（預設輸出仍維持易讀性）。
- `gateway install` 預設使用 Node 執行環境；不建議使用 bun（WhatsApp/Telegram 有錯誤）。
- `gateway install` 選項包括：`--port`、`--runtime`、`--token`、`--force`、`--json`。

### `logs`

透過 RPC 追蹤 Gateway 檔案日誌。

備註：

- TTY 會話會呈現彩色且結構化的檢視；非 TTY 則回退為純文字。
- `--json` 輸出以換行分隔的 JSON（每行一個日誌事件）。

範例：

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI 輔助工具（請使用 `--url`、`--token`、`--password`、`--timeout`、`--expect-final` 作為 RPC 子指令）。
當你傳入 `--url` 時，CLI 不會自動套用設定或環境憑證。
請明確包含 `--token` 或 `--password`。缺少明確憑證會導致錯誤。

子指令：

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

常用 RPC：

- `config.apply`（驗證 + 寫入設定 + 重啟 + 喚醒）
- `config.patch`（合併部分更新 + 重啟 + 喚醒）
- `update.run`（執行更新 + 重啟 + 喚醒）

提示：當直接呼叫 `config.set`/`config.apply`/`config.patch` 時，若已有設定，請從 `config.get` 傳遞 `baseHash`。

## 模型

請參考 [/concepts/models](/concepts/models) 了解回退行為與掃描策略。

Anthropic setup-token（支援）：

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

政策說明：這是技術相容性問題。Anthropic 過去曾封鎖部分訂閱在 Claude Code 以外的使用；在生產環境中依賴 setup-token 前，請先確認目前 Anthropic 的條款。

### `models` (根目錄)

`openclaw models` 是 `models status` 的別名。

根目錄選項：

- `--status-json`（`models status --json` 的別名）
- `--status-plain`（`models status --plain` 的別名）

### `models list`

選項：

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

選項：

- `--json`
- `--plain`
- `--check`（退出碼 1=已過期/缺失，2=即將過期）
- `--probe`（對已設定的認證設定進行即時探測）
- `--probe-provider <name>`
- `--probe-profile <id>`（重複或以逗號分隔）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

始終包含認證總覽及認證存儲中設定檔的 OAuth 到期狀態。
`--probe` 執行即時請求（可能會消耗 token 並觸發速率限制）。

### `models set <model>`

設定 `agents.defaults.model.primary`。

### `models set-image <model>`

設定 `agents.defaults.imageModel.primary`。

### `models aliases list|add|remove`

選項：

- `list`：`--json`，`--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

選項：

- `list`：`--json`、`--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

選項：

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

選項：

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

選項：

- `add`：互動式認證輔助工具
- `setup-token`：`--provider <name>`（預設 `anthropic`）、`--yes`
- `paste-token`：`--provider <name>`、`--profile-id <id>`、`--expires-in <duration>`

### `models auth order get|set|clear`

選項：

- `get`：`--provider <name>`、`--agent <id>`、`--json`
- `set`：`--provider <name>`、`--agent <id>`、`<profileIds...>`
- `clear`：`--provider <name>`、`--agent <id>`

## 系統

### `system event`

將系統事件加入佇列，並可選擇觸發心跳（Gateway RPC）。

必填：

- `--text <text>`

選項：

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat 控制（Gateway RPC）。

選項：

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

列出系統存在條目（Gateway RPC）。

選項：

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

管理排程工作（Gateway RPC）。詳見 [/automation/cron-jobs](/automation/cron-jobs)。

子指令：

- `cron status [--json]`
- `cron list [--all] [--json]`（預設以表格輸出；使用 `--json` 可輸出原始格式）
- `cron add`（別名：`create`；需搭配 `--name`，並且必須從 `--at` | `--every` | `--cron` 中選擇一項，且必須從 `--system-event` | `--message` 中選擇一個有效載荷）
- `cron edit <id>`（修補欄位）
- `cron rm <id>`（別名：`remove`、`delete`）
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

所有 `cron` 指令皆接受 `--url`、`--token`、`--timeout`、`--expect-final`。

## 節點主機

`node` 執行 **無頭節點主機** 或以背景服務方式管理它。詳見 `openclaw node`](/cli/node)。

子指令：

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

認證說明：

- `node` 從環境變數/設定解析閘道認證（無 `--token`/`--password` 參數）：先 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`，接著 `gateway.auth.*`。在本地模式下，node host 故意忽略 `gateway.remote.*`；在 `gateway.mode=remote` 中，`gateway.remote.*` 依遠端優先規則參與。
- 傳統 `CLAWDBOT_GATEWAY_*` 環境變數故意忽略於 node-host 認證解析。

## 節點

`nodes` 與閘道通訊並針對配對節點。詳見 [/nodes](/nodes)。

常用選項：

- `--url`, `--token`, `--timeout`, `--json`

子指令：

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>`（mac 節點或無頭節點主機）
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]`（僅限 mac）

相機：

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

畫布 + 螢幕：

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

## 瀏覽器

瀏覽器控制 CLI（專用於 Chrome/Brave/Edge/Chromium）。請參考 [`openclaw browser`](/cli/browser) 以及 [瀏覽器工具](/tools/browser)。

常用選項：

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

檢查：

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

## 文件搜尋

### `docs [query...]`

搜尋即時文件索引。

## TUI

### `tui`

開啟連接至 Gateway 的終端使用者介面。

選項：

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>`（預設為 `agents.defaults.timeoutSeconds`）
- `--history-limit <n>`
