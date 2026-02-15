```
---
summary: "OpenClaw CLI `openclaw` 命令、子命令和選項的參考"
read_when:
  - 增加或修改 CLI 命令或選項
  - 文件化新的命令介面
title: "CLI 參考"
---

# CLI 參考

本頁描述當前的 CLI 行為。如果命令變更，請更新此文件。

## 命令頁面

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
- [`plugins`](/cli/plugins) (插件命令)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (插件；如果已安裝)

## 全域旗標

- `--dev`: 在 `~/.openclaw-dev` 下隔離狀態並更改預設連接埠。
- `--profile <name>`: 在 `~/.openclaw-<name>` 下隔離狀態。
- `--no-color`: 禁用 ANSI 顏色。
- `--update`: `openclaw update` 的簡寫 (僅限原始碼安裝)。
- `-V`, `--version`, `-v`: 列印版本並退出。

## 輸出樣式

- ANSI 顏色和進度指標僅在 TTY 工作階段中呈現。
- OSC-8 超連結在支援的終端機中會顯示為可點擊的連結；否則，我們將回退到純文字 URL。
- `--json` (和在支援情況下的 `--plain`) 禁用樣式以實現清晰輸出。
- `--no-color` 禁用 ANSI 樣式；`NO_COLOR=1` 也受支援。
- 長時間執行的命令會顯示進度指標 (在支援情況下為 OSC 9;4)。

## 調色盤

OpenClaw 使用龍蝦調色盤進行 CLI 輸出。

- `accent` (#FF5A2D): 標題、標籤、主要強調。
- `accentBright` (#FF7A3D): 命令名稱、強調。
- `accentDim` (#D14A22): 次要強調文字。
- `info` (#FF8A5B): 資訊值。
- `success` (#2FBF71): 成功狀態。
- `warn` (#FFB020): 警告、回退、注意。
- `error` (#E23D2D): 錯誤、失敗。
- `muted` (#8B7F77): 弱化、中繼資料。

調色盤的真實來源：`src/terminal/palette.ts` (又稱「龍蝦縫」)。

## 命令樹

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

注意：插件可以添加額外的頂層命令 (例如 `openclaw voicecall`)。

## 安全

- `openclaw security audit` — 審核設定 + 本機狀態，查找常見的安全漏洞。
- `openclaw security audit --deep` — 盡力而為的 Gateway 即時探測。
- `openclaw security audit --fix` — 收緊安全預設值並修改狀態/設定的檔案權限。

## 插件

管理擴充功能及其設定：

- `openclaw plugins list` — 發現插件 (使用 `--json` 取得機器可讀輸出)。
- `openclaw plugins info <id>` — 顯示插件的詳細資訊。
- `openclaw plugins install <path|.tgz|npm-spec>` — 安裝插件 (或將插件路徑新增到 `plugins.load.paths`)。
- `openclaw plugins enable <id>` / `disable <id>` — 切換 `plugins.entries.<id>.enabled`。
- `openclaw plugins doctor` — 報告插件載入錯誤。

大多數插件變更需要 Gateway 重新啟動。請參閱 [/plugin](/tools/plugin)。

## 記憶體

對 `MEMORY.md` + `memory/*.md` 進行向量搜尋：

- `openclaw memory status` — 顯示索引狀態。
- `openclaw memory index` — 重新索引記憶體檔案。
- `openclaw memory search "<query>"` — 對記憶體進行語義搜尋。

## 聊天斜線命令

聊天訊息支援 `/...` 命令 (文字和原生)。請參閱 [/tools/slash-commands](/tools/slash-commands)。

重點：

- `/status` 用於快速診斷。
- `/config` 用於持久化設定變更。
- `/debug` 用於僅限執行時的設定覆寫 (記憶體中，而非磁碟；需要 `commands.debug: true`)。

## 設定 + 新手導覽

### `setup`

初始化設定 + 工作區。

選項：

- `--workspace <dir>`: 智慧代理工作區路徑 (預設 `~/.openclaw/workspace`)。
- `--wizard`: 執行新手導覽精靈。
- `--non-interactive`: 無提示執行精靈。
- `--mode <local|remote>`: 精靈模式。
- `--remote-url <url>`: 遠端 Gateway URL。
- `--remote-token <token>`: 遠端 Gateway 憑證。

當任何精靈旗標存在時 (`--non-interactive`、`--mode`、`--remote-url`、`--remote-token`)，精靈會自動執行。

### `onboard`

互動式精靈，用於設定 Gateway、工作區和 Skills。

選項：

- `--workspace <dir>`
- `--reset` (在精靈之前重設設定 + 憑證 + 工作階段 + 工作區)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual 是 advanced 的別名)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|custom-api-key|skip>`
- `--token-provider <id>` (非互動式；與 `--auth-choice token` 一起使用)
- `--token <token>` (非互動式；與 `--auth-choice token` 一起使用)
- `--token-profile-id <id>` (非互動式；預設：`<provider>:manual`)
- `--token-expires-in <duration>` (非互動式；例如 `365d`、`12h`)
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
- `--custom-base-url <url>` (非互動式；與 `--auth-choice custom-api-key` 一起使用)
- `--custom-model-id <id>` (非互動式；與 `--auth-choice custom-api-key` 一起使用)
- `--custom-api-key <key>` (非互動式；可選；與 `--auth-choice custom-api-key` 一起使用；如果省略則回退到 `CUSTOM_API_KEY`)
- `--custom-provider-id <id>` (非互動式；可選的自訂供應商 ID)
- `--custom-compatibility <openai|anthropic>` (非互動式；可選；預設 `openai`)
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (別名：`--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (建議使用 pnpm；不建議將 bun 用於 Gateway 執行時)
- `--json`

### `configure`

互動式設定精靈 (模型、頻道、Skills、Gateway)。

### `config`

非互動式設定輔助工具 (get/set/unset)。不帶子命令執行 `openclaw config` 會啟動精靈。

子命令：

- `config get <path>`: 列印設定值 (點/中括號路徑)。
- `config set <path> <value>`: 設定值 (JSON5 或原始字串)。
- `config unset <path>`: 移除值。

### `doctor`

健康檢查 + 快速修復 (設定 + Gateway + 傳統服務)。

選項：

- `--no-workspace-suggestions`: 禁用工作區記憶體提示。
- `--yes`: 接受預設值而不提示 (無頭模式)。
- `--non-interactive`: 跳過提示；僅套用安全遷移。
- `--deep`: 掃描系統服務以查找額外的 Gateway 安裝。

## 頻道輔助工具

### `channels`

管理聊天頻道帳戶 (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (插件)/Signal/iMessage/MS Teams)。

子命令：

- `channels list`: 顯示已設定的頻道和憑證個人檔案。
- `channels status`: 檢查 Gateway 可達性與頻道健康狀況 (`--probe` 執行額外檢查；使用 `openclaw health` 或 `openclaw status --deep` 進行 Gateway 健康探測)。
- 提示：當 `channels status` 可以偵測到常見的錯誤設定時，它會列印帶有建議修復的警告 (然後引導您前往 `openclaw doctor`)。
- `channels logs`: 顯示 Gateway 日誌檔案中的最新頻道日誌。
- `channels add`: 當未傳遞任何旗標時，為精靈式設定；旗標切換到非互動模式。
- `channels remove`: 預設禁用；傳遞 `--delete` 以在沒有提示的情況下移除設定條目。
- `channels login`: 互動式頻道登入 (僅限 WhatsApp Web)。
- `channels logout`: 登出頻道工作階段 (如果支援)。

通用選項：

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: 頻道帳戶 ID (預設 `default`)
- `--name <label>`: 帳戶的顯示名稱

`channels login` 選項：

- `--channel <channel>` (預設 `whatsapp`；支援 `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

`channels logout` 選項：

- `--channel <channel>` (預設 `whatsapp`)
- `--account <id>`

`channels list` 選項：

- `--no-usage`: 跳過模型供應商使用量/配額快照 (僅限 OAuth/API 支援)。
- `--json`: 輸出 JSON (除非設定 `--no-usage`，否則包含使用量)。

`channels logs` 選項：

- `--channel <name|all>` (預設 `all`)
- `--lines <n>` (預設 `200`)
- `--json`

更多詳細資訊：[/concepts/oauth](/concepts/oauth)

範例：

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

列出並檢查可用的 Skills 以及就緒資訊。

子命令：

- `skills list`: 列出 Skills (沒有子命令時的預設)。
- `skills info <name>`: 顯示單一 Skill 的詳細資訊。
- `skills check`: 總結已就緒與缺少的要求。

選項：

- `--eligible`: 僅顯示已就緒的 Skills。
- `--json`: 輸出 JSON (無樣式)。
- `-v`, `--verbose`: 包含缺少要求的詳細資訊。

提示：使用 `npx clawhub` 搜尋、安裝和同步 Skills。

### `pairing`

批准跨頻道的私訊配對請求。

子命令：

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub Hook 設定 + 執行程式。請參閱 [/automation/gmail-pubsub](/automation/gmail-pubsub)。

子命令：

- `webhooks gmail setup` (需要 `--account <email>`；支援 `--project`、`--topic`、`--subscription`、`--label`、`--hook-url`、`--hook-token`、`--push-token`、`--bind`、`--port`、`--path`、`--include-body`、`--max-bytes`、`--renew-minutes`、`--tailscale`、`--tailscale-path`、`--tailscale-target`、`--push-endpoint`、`--json`)
- `webhooks gmail run` (相同旗標的執行時覆寫)

### `dns setup`

廣域裝置探索 DNS 輔助工具 (CoreDNS + Tailscale)。請參閱 [/gateway/discovery](/gateway/discovery)。

選項：

- `--apply`: 安裝/更新 CoreDNS 設定 (需要 sudo；僅限 macOS)。

## 訊息傳遞 + 智慧代理

### `message`

統一的出站訊息傳遞 + 頻道操作。

請參閱：[/cli/message](/cli/message)

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

範例：

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

透過 Gateway 執行一次智慧代理迴圈 (或 `--local` 嵌入式)。

必填：

- `--message <text>`

選項：

- `--to <dest>` (用於工作階段金鑰和可選的傳遞)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (僅限 GPT-5.2 + Codex 模型)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

管理隔離的智慧代理 (工作區 + 憑證 + 路由)。

#### `agents list`

列出已設定的智慧代理。

選項：

- `--json`
- `--bindings`

#### `agents add [name]`

新增一個新的隔離智慧代理。除非傳遞了旗標 (或 `--non-interactive`)，否則會執行引導式精靈；在非互動模式下需要 `--workspace`。

選項：

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (可重複)
- `--non-interactive`
- `--json`

綁定規格使用 `channel[:accountId]`。當 WhatsApp 省略 `accountId` 時，使用預設帳戶 ID。

#### `agents delete <id>`

刪除智慧代理並修剪其工作區 + 狀態。

選項：

- `--force`
- `--json`

### `acp`

執行將 IDE 連接到 Gateway 的 ACP 橋接器。

請參閱 [`acp`](/cli/acp) 了解完整的選項和範例。

### `status`

顯示連結的工作階段健康狀況和最近的收件人。

選項：

- `--json`
- `--all` (完整診斷；唯讀，可貼上)
- `--deep` (探測頻道)
- `--usage` (顯示模型供應商使用量/配額)
- `--timeout <ms>`
- `--verbose`
- `--debug` (別名為 `--verbose`)

注意事項：

- 總覽包含 Gateway + 節點主機服務狀態 (如果可用)。

### 使用量追蹤

當 OAuth/API 憑證可用時，OpenClaw 可以顯示供應商使用量/配額。

介面：

- `/status` (在可用時添加簡短的供應商使用量行)
- `openclaw status --usage` (列印完整的供應商明細)
- macOS 選單列 (上下文下的使用量部分)

注意事項：

- 資料直接來自供應商使用量端點 (無估計)。
- 供應商：Anthropic、GitHub Copilot、OpenAI Codex OAuth，以及啟用這些供應商插件時的 Gemini CLI/Antigravity。
- 如果沒有匹配的憑證，則使用量隱藏。
- 詳細資訊：請參閱 [Usage tracking](/concepts/usage-tracking)。

### `health`

從正在執行的 Gateway 獲取健康狀況。

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

重設本機設定/狀態 (保留 CLI 安裝)。

選項：

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

注意事項：

- `--non-interactive` 需要 `--scope` 和 `--yes`。

### `uninstall`

解除安裝 Gateway 服務 + 本機資料 (CLI 仍然存在)。

選項：

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

注意事項：

- `--non-interactive` 需要 `--yes` 和明確的範圍 (或 `--all`)。

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
- `--reset` (重設開發設定 + 憑證 + 工作階段 + 工作區)
- `--force` (強制終止連接埠上的現有監聽器)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (別名為 `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

管理 Gateway 服務 (launchd/systemd/schtasks)。

子命令：

- `gateway status` (預設探測 Gateway RPC)
- `gateway install` (服務安裝)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

注意事項：

- `gateway status` 預設使用服務解析的連接埠/設定探測 Gateway RPC (使用 `--url/--token/--password` 覆寫)。
- `gateway status` 支援 `--no-probe`、`--deep` 和 `--json` 用於腳本編寫。
- `gateway status` 還會在偵測到時顯示舊版或額外的 Gateway 服務 (`--deep` 會添加系統級掃描)。以個人檔案命名的 OpenClaw 服務被視為一流服務，不會被標記為「額外」。
- `gateway status` 列印 CLI 使用的設定路徑與服務可能使用的設定 (服務環境)，以及解析後的探測目標 URL。
- `gateway install|uninstall|start|stop|restart` 支援 `--json` 用於腳本編寫 (預設輸出保持人性化)。
- `gateway install` 預設為 Node 執行時；**不建議**使用 bun (WhatsApp/Telegram 錯誤)。
- `gateway install` 選項：`--port`、`--runtime`、`--token`、`--force`、`--json`。

### `logs`

透過 RPC 追蹤 Gateway 檔案日誌。

注意事項：

- TTY 工作階段會呈現彩色、結構化的檢視；非 TTY 則回退到純文字。
- `--json` 輸出以換行符分隔的 JSON (每行一個日誌事件)。

範例：

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI 輔助工具 (用於 RPC 子命令時使用 `--url`、`--token`、`--password`、`--timeout`、`--expect-final`)。
當您傳遞 `--url` 時，CLI 不會自動套用設定或環境憑證。
明確包含 `--token` 或 `--password`。缺少明確憑證會導致錯誤。

子命令：

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

常見 RPCs：

- `config.apply` (驗證 + 寫入設定 + 重新啟動 + 喚醒)
- `config.patch` (合併部分更新 + 重新啟動 + 喚醒)
- `update.run` (執行更新 + 重新啟動 + 喚醒)

提示：當直接呼叫 `config.set`/`config.apply`/`config.patch` 時，如果設定已存在，則傳遞 `config.get` 中的 `baseHash`。

## 模型

請參閱 [/concepts/models](/concepts/models) 了解回退行為和掃描策略。

首選 Anthropic 憑證 (setup-token)：

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (根)

`openclaw models` 是 `models status` 的別名。

根選項：

- `--status-json` (別名為 `models status --json`)
- `--status-plain` (別名為 `models status --plain`)

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
- `--check` (退出 1=過期/遺失，2=即將過期)
- `--probe` (對設定的憑證個人檔案進行即時探測)
- `--probe-provider <name>`
- `--probe-profile <id>` (重複或以逗號分隔)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

始終包含憑證總覽和憑證儲存中個人檔案的 OAuth 到期狀態。
`--probe` 執行即時請求 (可能會消耗憑證並觸發速率限制)。

### `models set <model>`

設定 `agents.defaults.model.primary`。

### `models set-image <model>`

設定 `agents.defaults.imageModel.primary`。

### `models aliases list|add|remove`

選項：

- `list`: `--json`、`--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

選項：

- `list`: `--json`、`--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

選項：

- `list`: `--json`、`--plain`
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

- `add`: 互動式憑證輔助工具
- `setup-token`: `--provider <name>` (預設 `anthropic`)、`--yes`
- `paste-token`: `--provider <name>`、`--profile-id <id>`、`--expires-in <duration>`

### `models auth order get|set|clear`

選項：

- `get`: `--provider <name>`、`--agent <id>`、`--json`
- `set`: `--provider <name>`、`--agent <id>`、`<profileIds...>`
- `clear`: `--provider <name>`、`--agent <id>`

## 系統

### `system event`

將系統事件加入佇列並可選地觸發心跳 (Gateway RPC)。

必填：

- `--text <text>`

選項：

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

### `system heartbeat last|enable|disable`

心跳控制 (Gateway RPC)。

選項：

- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

### `system presence`

列出系統存在條目 (Gateway RPC)。

選項：

- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

## 定時任務

管理排程作業 (Gateway RPC)。請參閱 [/automation/cron-jobs](/automation/cron-jobs)。

子命令：

- `cron status [--json]`
- `cron list [--all] [--json]` (預設為表格輸出；使用 `--json` 取得原始輸出)
- `cron add` (別名：`create`；需要 `--name` 和 `--at` | `--every` | `--cron` 中的一個，以及 `--system-event` | `--message` 中的一個有效負載)
- `cron edit <id>` (修補欄位)
- `cron rm <id>` (別名：`remove`、`delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

所有 `cron` 命令都接受 `--url`、`--token`、`--timeout`、`--expect-final`。

## 節點主機

`node` 執行一個**無頭節點主機**或將其作為背景服務進行管理。請參閱 [`openclaw node`](/cli/node)。

子命令：

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## 節點

`nodes` 與 Gateway 通訊並定位已配對的節點。請參閱 [/nodes](/nodes)。

通用選項：

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
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac 節點或無頭節點主機)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (僅限 mac)

攝影機：

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

瀏覽器控制 CLI (專用 Chrome/Brave/Edge/Chromium)。請參閱 [`openclaw browser`](/cli/browser) 和 [Browser tool](/tools/browser)。

通用選項：

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

## 終端機使用者介面

### `tui`

開啟連接到 Gateway 的終端機使用者介面。

選項：

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (預設為 `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
```
