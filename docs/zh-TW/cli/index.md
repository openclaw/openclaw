---
summary: "OpenClaw CLI 參考指南，包含 `openclaw` 指令、子指令與選項"
read_when:
  - 新增或修改 CLI 指令或選項
  - 記錄新的指令介面
title: "CLI 參考指南"
---

# CLI 參考指南

本頁面說明目前的 CLI 行為。若指令有所變更，請更新此文件。

## 指令頁面

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
- [`plugins`](/cli/plugins)（外掛程式指令）
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall)（外掛程式；若已安裝）

## 全域旗標

- `--dev`：在 `~/.openclaw-dev` 下隔離狀態並偏移預設埠號。
- `--profile <name>`：在 `~/.openclaw-<name>` 下隔離狀態。
- `--no-color`：停用 ANSI 顏色。
- `--update`：`openclaw update` 的縮寫（僅限源碼安裝）。
- `-V`, `--version`, `-v`：列印版本資訊並退出。

## 輸出樣式

- ANSI 顏色與進度指示器僅在 TTY 工作階段中渲染。
- OSC-8 超連結在支援的終端機中渲染為可點擊連結；否則回退至純文字 URL。
- `--json`（以及支援處的 `--plain`）會停用樣式以獲得乾淨的輸出。
- `--no-color` 停用 ANSI 樣式；亦支援 `NO_COLOR=1` 環境變數。
- 執行時間較長的指令會顯示進度指示器（支援時使用 OSC 9;4）。

## 色盤

OpenClaw 在 CLI 輸出中使用龍蝦色盤（lobster palette）。

- `accent` (#FF5A2D)：標題、標籤、主要醒目提示。
- `accentBright` (#FF7A3D)：指令名稱、強調。
- `accentDim` (#D14A22)：次要醒目提示文字。
- `info` (#FF8A5B)：資訊性數值。
- `success` (#2FBF71)：成功狀態。
- `warn` (#FFB020)：警告、回退、注意。
- `error` (#E23D2D)：錯誤、失敗。
- `muted` (#8B7F77)：去強調、元數據。

色盤的真實來源：`src/terminal/palette.ts`（又稱為「lobster seam」）。

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

注意：外掛程式可以新增額外的頂層指令（例如 `openclaw voicecall`）。

## 安全性

- `openclaw security audit` — 稽核設定與在地狀態，檢查常見的安全性隱患。
- `openclaw security audit --deep` — 盡力而為的即時 Gateway 探測。
- `openclaw security audit --fix` — 收緊安全預設值並對狀態/設定執行 chmod。

## 外掛程式

管理擴充功能及其設定：

- `openclaw plugins list` — 探索外掛程式（使用 `--json` 獲得機器可讀輸出）。
- `openclaw plugins info <id>` — 顯示特定外掛程式的詳情。
- `openclaw plugins install <path|.tgz|npm-spec>` — 安裝外掛程式（或將外掛程式路徑加入 `plugins.load.paths`）。
- `openclaw plugins enable <id>` / `disable <id>` — 切換 `plugins.entries.<id>.enabled`。
- `openclaw plugins doctor` — 回報外掛程式載入錯誤。

大多數外掛程式變更需要重新啟動 Gateway。請參閱 [/plugin](/tools/plugin)。

## 記憶體

對 `MEMORY.md` + `memory/*.md` 進行向量搜尋：

- `openclaw memory status` — 顯示索引統計資料。
- `openclaw memory index` — 重新索引記憶體檔案。
- `openclaw memory search "<query>"` — 對記憶體進行語義搜尋。

## 聊天斜線指令

聊天訊息支援 `/...` 指令（文字與原生指令）。請參閱 [/tools/slash-commands](/tools/slash-commands)。

重點功能：

- `/status` 用於快速診斷。
- `/config` 用於持久性的設定變更。
- `/debug` 用於僅限執行時的設定覆寫（儲存於記憶體而非磁碟；需要 `commands.debug: true`）。

## Setup + 新手導覽

### `setup`

初始化設定與工作區。

選項：

- `--workspace <dir>`：智慧代理工作區路徑（預設為 `~/.openclaw/workspace`）。
- `--wizard`：執行新手導覽精靈。
- `--non-interactive`：執行精靈而不顯示提示。
- `--mode <local|remote>`：精靈模式。
- `--remote-url <url>`：遠端 Gateway URL。
- `--remote-token <token>`：遠端 Gateway 憑證。

當存在任何精靈旗標（`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`）時，精靈會自動執行。

### `onboard`

設定 Gateway、工作區與 Skills 的互動式精靈。

選項：

- `--workspace <dir>`
- `--reset`（在執行精靈前重設設定 + 憑證 + 工作階段 + 工作區）
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>`（manual 是 advanced 的別名）
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|custom-api-key|skip>`
- `--token-provider <id>`（非互動式；與 `--auth-choice token` 搭配使用）
- `--token <token>`（非互動式；與 `--auth-choice token` 搭配使用）
- `--token-profile-id <id>`（非互動式；預設：`<provider>:manual`）
- `--token-expires-in <duration>`（非互動式；例如 `365d`, `12h`）
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
- `--custom-base-url <url>`（非互動式；與 `--auth-choice custom-api-key` 搭配使用）
- `--custom-model-id <id>`（非互動式；與 `--auth-choice custom-api-key` 搭配使用）
- `--custom-api-key <key>`（非互動式；選填；與 `--auth-choice custom-api-key` 搭配使用；若省略則回退至 `CUSTOM_API_KEY`）
- `--custom-provider-id <id>`（非互動式；選填的自訂供應商 ID）
- `--custom-compatibility <openai|anthropic>`（非互動式；選填；預設為 `openai`）
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
- `--no-install-daemon`（別名：`--skip-daemon`）
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>`（推薦使用 pnpm；Gateway 執行時不推薦使用 bun）
- `--json`

### `configure`

互動式設定精靈（模型、頻道、Skills、Gateway）。

### `config`

非互動式設定小幫手（get/set/unset）。不帶子指令執行 `openclaw config` 將啟動精靈。

子指令：

- `config get <path>`：列印設定值（點號/方括號路徑）。
- `config set <path> <value>`：設定值（JSON5 或原始字串）。
- `config unset <path>`：移除一個值。

### `doctor`

健康檢查 + 快速修復（設定 + Gateway + 舊版服務）。

選項：

- `--no-workspace-suggestions`：停用工作區記憶體提示。
- `--yes`：不經提示直接接受預設值（無介面模式）。
- `--non-interactive`：跳過提示；僅套用安全的遷移。
- `--deep`：掃描系統服務以尋找額外的 Gateway 安裝。

## 頻道小幫手

### `channels`

管理聊天頻道帳號（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (外掛程式)/Signal/iMessage/MS Teams）。

子指令：

- `channels list`：顯示已設定的頻道與認證設定檔。
- `channels status`：檢查 Gateway 連通性與頻道健康狀況（`--probe` 執行額外檢查；使用 `openclaw health` 或 `openclaw status --deep` 進行 Gateway 健康探測）。
- 提示：當 `channels status` 偵測到常見的錯誤設定時，會列印警告與修復建議（然後引導您使用 `openclaw doctor`）。
- `channels logs`：顯示來自 Gateway 記錄檔的最新頻道記錄。
- `channels add`：未傳遞旗標時為精靈風格設定；旗標會切換至非互動式模式。
- `channels remove`：預設為停用；傳遞 `--delete` 以移除設定項目而不顯示提示。
- `channels login`：互動式頻道登入（僅限 WhatsApp Web）。
- `channels logout`：登出頻道工作階段（若支援）。

常用選項：

- `--channel <name>`：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`：頻道帳號 ID（預設為 `default`）
- `--name <label>`：帳號顯示名稱

`channels login` 選項：

- `--channel <channel>`（預設為 `whatsapp`；支援 `whatsapp`/`web`）
- `--account <id>`
- `--verbose`

`channels logout` 選項：

- `--channel <channel>`（預設為 `whatsapp`）
- `--account <id>`

`channels list` 選項：

- `--no-usage`：跳過模型供應商使用量/配額快照（僅限 OAuth/API 支援）。
- `--json`：輸出 JSON（除非設置 `--no-usage`，否則包含使用量）。

`channels logs` 選項：

- `--channel <name|all>`（預設為 `all`）
- `--lines <n>`（預設為 `200`）
- `--json`

更多詳情：[/concepts/oauth](/concepts/oauth)

範例：

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

列出並檢查可用的 Skills 以及就緒狀態資訊。

子指令：

- `skills list`：列出 Skills（未帶子指令時的預設行為）。
- `skills info <name>`：顯示單一 Skill 的詳情。
- `skills check`：就緒與缺失需求的摘要。

選項：

- `--eligible`：僅顯示已就緒的 Skills。
- `--json`：輸出 JSON（無樣式）。
- `-v`, `--verbose`：包含缺失需求的詳情。

提示：使用 `npx clawhub` 來搜尋、安裝與同步 Skills。

### `pairing`

核准跨頻道的私訊配對請求。

子指令：

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub Hook 設定與執行器。請參閱 [/automation/gmail-pubsub](/automation/gmail-pubsub)。

子指令：

- `webhooks gmail setup`（需要 `--account <email>`；支援 `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`）
- `webhooks gmail run`（針對相同旗標的執行時覆寫）

### `dns setup`

廣域探索 DNS 小幫手（CoreDNS + Tailscale）。請參閱 [/gateway/discovery](/gateway/discovery)。

選項：

- `--apply`：安裝/更新 CoreDNS 設定（需要 sudo；僅限 macOS）。

## 訊息傳送 + 智慧代理

### `message`

統一的對外訊息傳送與頻道操作。

請參閱：[/cli/message](/cli/message)

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

透過 Gateway 執行一輪智慧代理操作（或使用 `--local` 嵌入式執行）。

必要項：

- `--message <text>`

選項：

- `--to <dest>`（用於工作階段金鑰與選填的傳送）
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>`（僅限 GPT-5.2 + Codex 模型）
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

管理隔離的智慧代理（工作區 + 認證 + 路由）。

#### `agents list`

列出已設定的智慧代理。

選項：

- `--json`
- `--bindings`

#### `agents add [name]`

新增一個隔離的智慧代理。除非傳遞旗標（或 `--non-interactive`），否則會執行引導精靈；在非互動模式下必須提供 `--workspace`。

選項：

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>`（可重複）
- `--non-interactive`
- `--json`

繫結規格使用 `channel[:accountId]`。若 WhatsApp 省略 `accountId`，則使用預設帳號 ID。

#### `agents delete <id>`

刪除一個智慧代理並修剪其工作區與狀態。

選項：

- `--force`
- `--json`

### `acp`

執行 ACP 橋接器，將 IDE 連接至 Gateway。

完整選項與範例請參閱 [`acp`](/cli/acp)。

### `status`

顯示連結的工作階段健康狀況與最近的收件者。

選項：

- `--json`
- `--all`（完整診斷；唯讀，可直接貼上）
- `--deep`（探測頻道）
- `--usage`（顯示模型供應商使用量/配額）
- `--timeout <ms>`
- `--verbose`
- `--debug`（`--verbose` 的別名）

備註：

- 概覽包含 Gateway 與 Node 主機服務狀態（若可用）。

### 使用量追蹤

當 OAuth/API 憑證可用時，OpenClaw 可以呈現供應商的使用量/配額。

呈現位置：

- `/status`（可用時會新增一列簡短的供應商使用量）
- `openclaw status --usage`（列印完整的供應商細目）
- macOS 選單列（Context 下的 Usage 區段）

備註：

- 數據直接來自供應商的使用量端點（非預估值）。
- 供應商：Anthropic, GitHub Copilot, OpenAI Codex OAuth，以及當啟用了這些供應商外掛程式時的 Gemini CLI/Antigravity。
- 若不存在符合的憑證，則隱藏使用量。
- 詳情：請參閱[使用量追蹤](/concepts/usage-tracking)。

### `health`

從執行中的 Gateway 獲取健康狀況。

選項：

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

列出儲存的對話工作階段。

選項：

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## 重設 / 解除安裝

### `reset`

重設在地設定/狀態（保留已安裝的 CLI）。

選項：

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

備註：

- `--non-interactive` 需要 `--scope` 與 `--yes`。

### `uninstall`

解除安裝 Gateway 服務與在地資料（保留 CLI）。

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

- `--non-interactive` 需要 `--yes` 與明確的範圍（或 `--all`）。

## Gateway

### `gateway`

執行 WebSocket Gateway。

選項：

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset`（重設開發環境設定 + 憑證 + 工作階段 + 工作區）
- `--force`（強制關閉埠號上現有的監聽器）
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact`（`--ws-log compact` 的別名）
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

管理 Gateway 服務 (launchd/systemd/schtasks)。

子指令：

- `gateway status`（預設探測 Gateway RPC）
- `gateway install`（服務安裝）
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

備註：

- `gateway status` 預設使用服務解析出的埠號/設定來探測 Gateway RPC（使用 `--url/--token/--password` 覆寫）。
- `gateway status` 支援 `--no-probe`, `--deep`, 與 `--json` 以用於腳本編寫。
- `gateway status` 在偵測到舊版或其他額外 Gateway 服務時也會呈現（`--deep` 增加系統級掃描）。以 Profile 命名的 OpenClaw 服務被視為第一類公民，不會被標記為「額外」。
- `gateway status` 會印出 CLI 使用的設定路徑與服務可能使用的設定（服務環境變數），以及解析出的探測目標 URL。
- `gateway install|uninstall|start|stop|restart` 支援 `--json` 以用於腳本編寫（預設輸出保持對人類友善）。
- `gateway install` 預設使用 Node 執行環境；**不推薦**使用 bun（會有 WhatsApp/Telegram 錯誤）。
- `gateway install` 選項：`--port`, `--runtime`, `--token`, `--force`, `--json`。

### `logs`

透過 RPC 追蹤 Gateway 檔案記錄。

備註：

- TTY 工作階段會渲染彩色、結構化的檢視；非 TTY 則回退至純文字。
- `--json` 發出以行分隔的 JSON（每行一個記錄事件）。

範例：

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI 小幫手（針對 RPC 子指令使用 `--url`, `--token`, `--password`, `--timeout`, `--expect-final`）。
當您傳遞 `--url` 時，CLI 不會自動套用設定或環境憑證。
請明確包含 `--token` 或 `--password`。缺少明確憑證將會發生錯誤。

子指令：

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

常用 RPC：

- `config.apply`（驗證 + 寫入設定 + 重新啟動 + 喚醒）
- `config.patch`（合併部分更新 + 重新啟動 + 喚醒）
- `update.run`（執行更新 + 重新啟動 + 喚醒）

提示：直接呼叫 `config.set`/`config.apply`/`config.patch` 時，若設定已存在，請傳遞來自 `config.get` 的 `baseHash`。

## 模型

關於回退行為與掃描策略，請參閱 [/concepts/models](/concepts/models)。

推薦的 Anthropic 認證方式 (setup-token)：

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models`（根指令）

`openclaw models` 是 `models status` 的別名。

根選項：

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
- `--check`（退出碼 1=已過期/缺失, 2=即將過期）
- `--probe`（對已設定的認證設定檔進行即時探測）
- `--probe-provider <name>`
- `--probe-profile <id>`（可重複或以逗號分隔）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

始終包含認證概覽以及認證存放區中設定檔的 OAuth 過期狀態。
`--probe` 會執行即時請求（可能會消耗權杖並觸發速率限制）。

### `models set <model>`

設定 `agents.defaults.model.primary`。

### `models set-image <model>`

設定 `agents.defaults.imageModel.primary`。

### `models aliases list|add|remove`

選項：

- `list`：`--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

選項：

- `list`：`--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

選項：

- `list`：`--json`, `--plain`
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

- `add`：互動式認證小幫手
- `setup-token`：`--provider <name>`（預設為 `anthropic`）, `--yes`
- `paste-token`：`--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

選項：

- `get`：`--provider <name>`, `--agent <id>`, `--json`
- `set`：`--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`：`--provider <name>`, `--agent <id>`

## 系統

### `system event`

將系統事件排入佇列，並可選擇觸發心跳（Gateway RPC）。

必要項：

- `--text <text>`

選項：

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

心跳控制（Gateway RPC）。

選項：

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

列出系統上線項目（Gateway RPC）。

選項：

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

管理排程任務（Gateway RPC）。請參閱 [/automation/cron-jobs](/automation/cron-jobs)。

子指令：

- `cron status [--json]`
- `cron list [--all] [--json]`（預設為表格輸出；使用 `--json` 取得原始資料）
- `cron add`（別名：`create`；需要 `--name` 以及 `--at` | `--every` | `--cron` 其中之一，以及 `--system-event` | `--message` 其中之一的承載資料）
- `cron edit <id>`（修正欄位）
- `cron rm <id>`（別名：`remove`, `delete`）
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

所有 `cron` 指令均接受 `--url`, `--token`, `--timeout`, `--expect-final`。

## Node 主機

`node` 執行一個**無介面 Node 主機**，或將其作為背景服務進行管理。請參閱 [`openclaw node`](/cli/node)。

子指令：

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`nodes` 與 Gateway 通訊並定位配對的節點。請參閱 [/nodes](/nodes)。

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
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>`（Mac 節點或無介面 Node 主機）
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]`（僅限 Mac）

攝影機：

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

畫布 (Canvas) + 螢幕：

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

瀏覽器控制 CLI（專用的 Chrome/Brave/Edge/Chromium）。請參閱 [`openclaw browser`](/cli/browser) 與[瀏覽器工具](/tools/browser)。

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

開啟連線至 Gateway 的終端機介面 (TUI)。

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
