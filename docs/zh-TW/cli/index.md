---
summary: "OpenClaw CLI 的 `openclaw` 指令、子指令與選項參考"
read_when:
  - 新增或修改 CLI 指令或選項時
  - 文件化新的指令介面時
title: "CLI 參考"
---

# CLI 參考

本頁描述目前的 CLI 行為。若指令有所變更，請更新本文件。 If commands change, update this doc.

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
- [`plugins`](/cli/plugins)（外掛指令）
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall)（外掛；若已安裝）

## 全域旗標

- `--dev`：在 `~/.openclaw-dev` 下隔離狀態，並調整預設連接埠。
- `--profile <name>`：在 `~/.openclaw-<name>` 下隔離狀態。
- `--no-color`：停用 ANSI 色彩。
- `--update`：`openclaw update` 的簡寫（僅限原始碼安裝）。
- `-V`、`--version`、`-v`：列印版本並結束。

## Output styling

- ANSI 色彩與進度指示器僅在 TTY 工作階段中呈現。
- OSC-8 超連結會在支援的終端機中呈現為可點擊連結；否則會回退為純 URL。
- `--json`（以及支援時的 `--plain`）會停用樣式以取得乾淨輸出。
- `--no-color` 會停用 ANSI 樣式；也會遵循 `NO_COLOR=1`。
- 長時間執行的指令會顯示進度指示器（支援時使用 OSC 9;4）。

## 色彩配置

OpenClaw 在 CLI 輸出中使用「lobster」色盤。

- `accent`（#FF5A2D）：標題、標籤、主要重點。
- `accentBright`（#FF7A3D）：指令名稱、強調。
- `accentDim`（#D14A22）：次要重點文字。
- `info`（#FF8A5B）：資訊性數值。
- `success`（#2FBF71）：成功狀態。
- `warn`（#FFB020）：警告、回退、注意事項。
- `error`（#E23D2D）：錯誤、失敗。
- `muted` (#8B7F77): de-emphasis, metadata.

色盤的唯一真實來源：`src/terminal/palette.ts`（亦稱「lobster seam」）。

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

注意：外掛可以新增額外的頂層指令（例如 `openclaw voicecall`）。

## 安全性

- `openclaw security audit` — 稽核設定與本機狀態，以找出常見的安全陷阱。
- `openclaw security audit --deep` — 盡力而為的即時 Gateway 閘道器 探測。
- `openclaw security audit --fix` — 強化安全預設值並對狀態／設定執行 chmod。

## Plugins

管理擴充功能及其設定：

- `openclaw plugins list` — 探索外掛（機器輸出請使用 `--json`）。
- `openclaw plugins info <id>` — 顯示外掛詳細資訊。
- `openclaw plugins install <path|.tgz|npm-spec>` — 安裝外掛（或將外掛路徑加入 `plugins.load.paths`）。
- `openclaw plugins enable <id>` / `disable <id>` — 切換 `plugins.entries.<id>.enabled`。
- `openclaw plugins doctor` — 回報外掛載入錯誤。

Most plugin changes require a gateway restart. See [/plugin](/tools/plugin).

## 記憶體

針對 `MEMORY.md` + `memory/*.md` 的向量搜尋：

- `openclaw memory status` — 顯示索引統計。
- `openclaw memory index` — 重新索引記憶體檔案。
- `openclaw memory search "<query>"` — 對記憶體進行語意搜尋。

## 聊天斜線指令

聊天訊息支援 `/...` 指令（文字與原生）。請參閱 [/tools/slash-commands](/tools/slash-commands)。 See [/tools/slash-commands](/tools/slash-commands).

Highlights:

- `/status` 用於快速診斷。
- `/config` 用於持久化的設定變更。
- `/debug` 用於僅限執行期的設定覆寫（記憶體，不寫入磁碟；需要 `commands.debug: true`）。

## 設定 + 入門引導

### `setup`

Initialize config + workspace.

選項：

- `--workspace <dir>`：代理程式工作區路徑（預設 `~/.openclaw/workspace`）。
- `--wizard`：執行入門引導精靈。
- `--non-interactive`：在無提示的情況下執行精靈。
- `--mode <local|remote>`：精靈模式。
- `--remote-url <url>`：遠端 Gateway 閘道器 URL。
- `--remote-token <token>`：遠端 Gateway 閘道器 權杖。

當出現任何精靈旗標（`--non-interactive`、`--mode`、`--remote-url`、`--remote-token`）時，精靈會自動執行。

### `onboard`

Interactive wizard to set up gateway, workspace, and skills.

選項：

- `--workspace <dir>`
- `--reset`（在精靈前重置設定 + 憑證 + 工作階段 + 工作區）
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>`（manual 是 advanced 的別名）
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>`（非互動；與 `--auth-choice token` 搭配使用）
- `--token <token>`（非互動；與 `--auth-choice token` 搭配使用）
- `--token-profile-id <id>`（非互動；預設：`<provider>:manual`）
- `--token-expires-in <duration>`（非互動；例如 `365d`、`12h`）
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
- `--no-install-daemon`（別名：`--skip-daemon`）
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>`（建議 pnpm；Gateway 閘道器 執行階段不建議 bun）
- `--json`

### `configure`

Interactive configuration wizard (models, channels, skills, gateway).

### `config`

Non-interactive config helpers (get/set/unset). Running `openclaw config` with no
subcommand launches the wizard.

子指令：

- `config get <path>`：列印設定值（點／中括號路徑）。
- `config set <path> <value>`：設定值（JSON5 或原始字串）。
- `config unset <path>`：移除設定值。

### `doctor`

Health checks + quick fixes (config + gateway + legacy services).

選項：

- `--no-workspace-suggestions`：停用工作區記憶體提示。
- `--yes`：不提示而接受預設值（無頭）。
- `--non-interactive`：略過提示；僅套用安全遷移。
- `--deep`：掃描系統服務以尋找額外的 Gateway 閘道器 安裝。

## 頻道輔助

### `channels`

管理聊天頻道帳號（WhatsApp／Telegram／Discord／Google Chat／Slack／Mattermost（外掛）／Signal／iMessage／MS Teams）。

子指令：

- `channels list`：顯示已設定的頻道與身分驗證設定檔。
- `channels status`：檢查 Gateway 閘道器 可達性與頻道健康度（`--probe` 會執行額外檢查；Gateway 閘道器 健康探測請使用 `openclaw health` 或 `openclaw status --deep`）。
- 提示：`channels status` 在可偵測常見設定錯誤時會列印警告並提供建議修正（並引導你至 `openclaw doctor`）。
- `channels logs`：從 Gateway 閘道器 記錄檔顯示近期頻道日誌。
- `channels add`：未傳遞旗標時為精靈式設定；傳遞旗標則切換為非互動模式。
- `channels remove`：預設停用；傳遞 `--delete` 可在無提示下移除設定項目。
- `channels login`：互動式頻道登入（僅 WhatsApp Web）。
- `channels logout`：登出頻道工作階段（若支援）。

常用選項：

- `--channel <name>`：`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`：頻道帳號 id（預設 `default`）
- `--name <label>`：帳號顯示名稱

`channels login` 選項：

- `--channel <channel>`（預設 `whatsapp`；支援 `whatsapp`/`web`）
- `--account <id>`
- `--verbose`

`channels logout` 選項：

- `--channel <channel>`（預設 `whatsapp`）
- `--account <id>`

`channels list` 選項：

- `--no-usage`：略過模型提供者使用量／額度快照（僅 OAuth／API 支援）。
- `--json`：輸出 JSON（除非設定 `--no-usage`，否則包含使用量）。

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

列出並檢視可用 Skills 以及就緒度資訊。

子指令：

- `skills list`：列出 Skills（未指定子指令時為預設）。
- `skills info <name>`：顯示單一 Skill 的詳細資訊。
- `skills check`：就緒與缺少需求的摘要。

選項：

- `--eligible`：僅顯示就緒的 Skills。
- `--json`：輸出 JSON（無樣式）。
- `-v`、`--verbose`：包含缺少需求的詳細資訊。

提示：使用 `npx clawhub` 來搜尋、安裝並同步 Skills。

### `pairing`

Approve DM pairing requests across channels.

子指令：

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub hook setup + runner. Gmail Pub/Sub 掛鉤設定 + 執行器。請參閱 [/automation/gmail-pubsub](/automation/gmail-pubsub)。

子指令：

- `webhooks gmail setup`（需要 `--account <email>`；支援 `--project`、`--topic`、`--subscription`、`--label`、`--hook-url`、`--hook-token`、`--push-token`、`--bind`、`--port`、`--path`、`--include-body`、`--max-bytes`、`--renew-minutes`、`--tailscale`、`--tailscale-path`、`--tailscale-target`、`--push-endpoint`、`--json`）
- `webhooks gmail run`（相同旗標的執行期覆寫）

### `dns setup`

廣域探索 DNS 輔助（CoreDNS + Tailscale）。請參閱 [/gateway/discovery](/gateway/discovery)。 See [/gateway/discovery](/gateway/discovery).

選項：

- `--apply`：安裝／更新 CoreDNS 設定（需要 sudo；僅 macOS）。

## 訊息 + 代理程式

### `message`

統一的外送訊息 + 頻道操作。

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

Run one agent turn via the Gateway (or `--local` embedded).

必要項目：

- `--message <text>`

選項：

- `--to <dest>`（用於工作階段金鑰與選擇性投遞）
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>`（僅 GPT-5.2 + Codex 模型）
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

管理隔離的代理程式（工作區 + 身分驗證 + 路由）。

#### `agents list`

列出已設定的代理程式。

選項：

- `--json`
- `--bindings`

#### `agents add [name]`

Add a new isolated agent. 新增一個隔離的代理程式。未傳遞旗標（或 `--non-interactive`）時會執行引導式精靈；在非互動模式下需要 `--workspace`。

選項：

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>`（可重複）
- `--non-interactive`
- `--json`

Binding specs use `channel[:accountId]`. 綁定規格使用 `channel[:accountId]`。對於 WhatsApp，若省略 `accountId`，會使用預設帳號 id。

#### `agents delete <id>`

Delete an agent and prune its workspace + state.

選項：

- `--force`
- `--json`

### `acp`

執行連接 IDE 與 Gateway 閘道器 的 ACP 橋接。

完整選項與範例請參閱 [`acp`](/cli/acp)。

### `status`

Show linked session health and recent recipients.

選項：

- `--json`
- `--all`（完整診斷；唯讀、可貼上）
- `--deep`（探測頻道）
- `--usage`（顯示模型提供者使用量／額度）
- `--timeout <ms>`
- `--verbose`
- `--debug`（`--verbose` 的別名）

注意事項：

- Overview includes Gateway + node host service status when available.

### 使用量追蹤

當 OAuth／API 憑證可用時，OpenClaw 可呈現提供者使用量／額度。

Surfaces:

- `/status`（可用時新增一行簡短的提供者使用量）
- `openclaw status --usage`（列印完整的提供者明細）
- macOS 選單列（Context 下的 Usage 區段）

注意事項：

- Data comes directly from provider usage endpoints (no estimates).
- 提供者：Anthropic、GitHub Copilot、OpenAI Codex OAuth，另在啟用對應提供者外掛時包含 Gemini CLI／Antigravity。
- 若不存在相符的憑證，使用量會隱藏。
- 詳細資訊：請參閱 [Usage tracking](/concepts/usage-tracking)。

### `health`

從正在執行的 Gateway 閘道器 擷取健康狀態。

選項：

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

List stored conversation sessions.

選項：

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## 重置／解除安裝

### `reset`

重置本機設定／狀態（保留 CLI 已安裝）。

選項：

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

注意事項：

- `--non-interactive` 需要 `--scope` 與 `--yes`。

### `uninstall`

Uninstall the gateway service + local data (CLI remains).

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

- `--non-interactive` 需要 `--yes` 與明確的範圍（或 `--all`）。

## Gateway

### `gateway`

執行 WebSocket Gateway 閘道器。

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
- `--reset`（重置開發設定 + 憑證 + 工作階段 + 工作區）
- `--force`（終止連接埠上的既有監聽）
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact`（`--ws-log compact` 的別名）
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

管理 Gateway 閘道器 服務（launchd／systemd／schtasks）。

子指令：

- `gateway status`（預設探測 Gateway RPC （遠端程序呼叫））
- `gateway install`（服務安裝）
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

注意事項：

- `gateway status` 會依服務解析後的連接埠／設定預設探測 Gateway RPC （遠端程序呼叫）（可用 `--url/--token/--password` 覆寫）。
- `gateway status` 支援 `--no-probe`、`--deep` 與 `--json` 以利腳本化。
- `gateway status` also surfaces legacy or extra gateway services when it can detect them (`--deep` adds system-level scans). Profile-named OpenClaw services are treated as first-class and aren't flagged as "extra".
- `gateway status` 會列印 CLI 使用的設定路徑與服務可能使用的設定（服務環境），以及解析後的探測目標 URL。
- `gateway install|uninstall|start|stop|restart` 支援 `--json` 以利腳本化（預設輸出仍維持對人友善）。
- `gateway install` 預設使用 Node 執行階段；**不建議** bun（WhatsApp／Telegram 問題）。
- `gateway install` 選項：`--port`、`--runtime`、`--token`、`--force`、`--json`。

### `logs`

透過 RPC 尾隨 Gateway 閘道器 檔案日誌。

注意事項：

- TTY sessions render a colorized, structured view; non-TTY falls back to plain text.
- `--json` 會輸出逐行 JSON（每行一個日誌事件）。

範例：

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI helpers (use `--url`, `--token`, `--password`, `--timeout`, `--expect-final` for RPC subcommands).
When you pass `--url`, the CLI does not auto-apply config or environment credentials.
Include `--token` or `--password` explicitly. Missing explicit credentials is an error.

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

提示：直接呼叫 `config.set`/`config.apply`/`config.patch` 時，
若設定已存在，請從 `config.get` 傳遞 `baseHash`。

## 模型

See [/concepts/models](/concepts/models) for fallback behavior and scanning strategy.

偏好的 Anthropic 驗證（setup-token）：

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models`（root）

`openclaw models` 是 `models status` 的別名。

Root 選項：

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
- `--check`（結束碼 1=過期／缺失，2=即將過期）
- `--probe`（即時探測已設定的驗證設定檔）
- `--probe-provider <name>`
- `--probe-profile <id>`（可重複或以逗號分隔）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Always includes the auth overview and OAuth expiry status for profiles in the auth store.
`--probe` runs live requests (may consume tokens and trigger rate limits).

### `models set <model>`

設定 `agents.defaults.model.primary`。

### `models set-image <model>`

設定 `agents.defaults.imageModel.primary`。

### `models aliases list|add|remove`

選項：

- `list`：`--json`、`--plain`
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

- `list`：`--json`、`--plain`
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

- `add`：互動式驗證輔助
- `setup-token`：`--provider <name>`（預設 `anthropic`）、`--yes`
- `paste-token`：`--provider <name>`、`--profile-id <id>`、`--expires-in <duration>`

### `models auth order get|set|clear`

選項：

- `get`：`--provider <name>`、`--agent <id>`、`--json`
- `set`：`--provider <name>`、`--agent <id>`、`<profileIds...>`
- `clear`：`--provider <name>`、`--agent <id>`

## 系統

### `system event`

加入系統事件佇列，並可選擇性觸發心跳（Gateway RPC （遠端程序呼叫））。

必要項目：

- `--text <text>`

選項：

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

### `system heartbeat last|enable|disable`

心跳控制（Gateway RPC （遠端程序呼叫））。

選項：

- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

### `system presence`

列出系統存在項目（Gateway RPC （遠端程序呼叫））。

選項：

- `--json`
- `--url`、`--token`、`--timeout`、`--expect-final`

## Cron

管理排程工作（Gateway RPC （遠端程序呼叫））。請參閱 [/automation/cron-jobs](/automation/cron-jobs)。 See [/automation/cron-jobs](/automation/cron-jobs).

子指令：

- `cron status [--json]`
- `cron list [--all] [--json]`（預設為表格輸出；原始輸出請使用 `--json`）
- `cron add`（別名：`create`；需要 `--name`，且在 `--at` | `--every` | `--cron` 中恰好一個，並在 `--system-event` | `--message` 中恰好一個負載）
- `cron edit <id>`（修補欄位）
- `cron rm <id>`（別名：`remove`、`delete`）
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

所有 `cron` 指令都接受 `--url`、`--token`、`--timeout`、`--expect-final`。

## Node 主機

`node` 會執行 **無頭節點主機**，或將其作為背景服務管理。請參閱
[`openclaw node`](/cli/node)。 See
[`openclaw node`](/cli/node).

子指令：

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`nodes` talks to the Gateway and targets paired nodes. See [/nodes](/nodes).

常用選項：

- `--url`、`--token`、`--timeout`、`--json`

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
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]`（僅 mac）

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

瀏覽器控制 CLI（專用 Chrome／Brave／Edge／Chromium）。請參閱 [`openclaw browser`](/cli/browser) 與 [Browser tool](/tools/browser)。 See [`openclaw browser`](/cli/browser) and the [Browser tool](/tools/browser).

常用選項：

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

檢視：

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

開啟連線至 Gateway 閘道器 的終端機 UI。

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
