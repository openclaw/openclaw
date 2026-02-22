---
summary: "`openclaw` အမိန့်များ၊ အမိန့်ခွဲများနှင့် ရွေးချယ်မှုများအတွက် OpenClaw CLI ကိုးကားချက်"
read_when:
  - CLI အမိန့်များ သို့မဟုတ် ရွေးချယ်မှုများကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်းအချိန်
  - အမိန့် မျက်နှာပြင်အသစ်များကို စာရွက်စာတမ်းရေးသားရာတွင်
title: "CLI ကိုးကားချက်"
---

# CLI ကိုးကားချက်

ဒီစာမျက်နှာမှာ လက်ရှိ CLI behavior ကို ဖော်ပြထားပါသည်။ command များ ပြောင်းလဲပါက ဒီ doc ကို update လုပ်ပါ။

## Command pages

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
- [`plugins`](/cli/plugins) (plugin အမိန့်များ)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin; ထည့်သွင်းထားပါက)

## Global flags

- `--dev`: အခြေအနေကို `~/.openclaw-dev` အောက်တွင် သီးခြားထားပြီး မူလ port များကို ရွှေ့ပြောင်းပါ။
- `--profile <name>`: အခြေအနေကို `~/.openclaw-<name>` အောက်တွင် သီးခြားထားပါ။
- `--no-color`: ANSI အရောင်များကို ပိတ်ပါ။
- `--update`: `openclaw update` အတွက် အတိုကောက် (source installs အတွက်သာ)။
- `-V`, `--version`, `-v`: ဗားရှင်းကို ပုံနှိပ်ပြီး ထွက်ပါ။

## Output styling

- ANSI အရောင်များနှင့် တိုးတက်မှု ပြသချက်များသည် TTY ဆက်ရှင်များတွင်သာ ပေါ်ပေါက်သည်။
- OSC-8 ဟိုက်ပါလင့်ခ်များကို ပံ့ပိုးထားသော terminal များတွင် နှိပ်နိုင်သော လင့်ခ်များအဖြစ် ပြသသည်။ မပံ့ပိုးပါက ရိုးရိုး URL များသို့ ပြန်လည်ကျသွားသည်။
- `--json` (နှင့် ပံ့ပိုးထားသည့်နေရာများတွင် `--plain`) သည် သန့်ရှင်းသော output အတွက် styling ကို ပိတ်ပါ။
- `--no-color` သည် ANSI styling ကို ပိတ်ပါသည်; `NO_COLOR=1` ကိုလည်း လိုက်နာပါသည်။
- အချိန်ကြာမြင့်သော အမိန့်များတွင် တိုးတက်မှု ပြသချက် (ပံ့ပိုးပါက OSC 9;4) ကို ပြသသည်။

## Color palette

OpenClaw သည် CLI output အတွက် lobster palette ကို အသုံးပြုသည်။

- `accent` (#FF5A2D): ခေါင်းစဉ်များ၊ လိပ်စာများ၊ အဓိက အလင်းတင်ချက်များ။
- `accentBright` (#FF7A3D): အမိန့်အမည်များ၊ အလေးပေးချက်။
- `accentDim` (#D14A22): ဒုတိယ အလင်းတင် စာသား။
- `info` (#FF8A5B): သတင်းအချက်အလက် တန်ဖိုးများ။
- `success` (#2FBF71): အောင်မြင်မှု အခြေအနေများ။
- `warn` (#FFB020): သတိပေးချက်များ၊ အစားထိုးအသုံးပြုမှုများ၊ အာရုံစိုက်ရန်။
- `error` (#E23D2D): အမှားများ၊ မအောင်မြင်မှုများ။
- `muted` (#8B7F77): အလေးမထားသည့်အချက်များ၊ မီတာဒေတာ။

Palette အတွက် အမှန်တကယ်ရင်းမြစ်: `src/terminal/palette.ts` (အခြားအမည် “lobster seam”)။

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

မှတ်ချက်: plugins များသည် အပေါ်ဆုံးအဆင့် အမိန့်အသစ်များကို ထပ်မံထည့်သွင်းနိုင်သည် (ဥပမာ `openclaw voicecall`)။

## Security

- `openclaw security audit` — လုံခြုံရေးဆိုင်ရာ အမှားများကို ရှာဖွေရန် config + local state ကို စစ်ဆေးပါ။
- `openclaw security audit --deep` — Gateway ကို တိုက်ရိုက် စမ်းသပ်စစ်ဆေးမှု (အကောင်းဆုံးကြိုးပမ်းမှု)။
- `openclaw security audit --fix` — လုံခြုံသော မူလတန်ဖိုးများကို တင်းကျပ်စေပြီး state/config ကို chmod လုပ်ပါ။

## Plugins

တိုးချဲ့မှုများနှင့် ၎င်းတို့၏ config ကို စီမံခန့်ခွဲပါ—

- `openclaw plugins list` — plugins များကို ရှာဖွေပါ (machine output အတွက် `--json` ကို အသုံးပြုပါ)။
- `openclaw plugins info <id>` — plugin တစ်ခုအတွက် အသေးစိတ် ပြသပါ။
- `openclaw plugins install <path|.tgz|npm-spec>` — plugin တစ်ခုကို ထည့်သွင်းပါ (သို့မဟုတ် plugin လမ်းကြောင်းကို `plugins.load.paths` ထဲသို့ ထည့်ပါ)။
- `openclaw plugins enable <id>` / `disable <id>` — `plugins.entries.<id>` ကို toggle လုပ်ပါ.enabled\`.
- `openclaw plugins doctor` — plugin load အမှားများကို အစီရင်ခံပါ။

Plugin အပြောင်းအလဲအများစုမှာ gateway ကို restart လုပ်ရန်လိုအပ်ပါသည်။ [/plugin](/tools/plugin) ကို ကြည့်ပါ။

## Memory

`MEMORY.md` + `memory/*.md` အပေါ် Vector search—

- `openclaw memory status` — index စာရင်းအင်းများကို ပြပါ။
- `openclaw memory index` — memory ဖိုင်များကို ပြန်လည် index ပြုလုပ်ပါ။
- `openclaw memory search "<query>"` — memory အပေါ် semantic search ပြုလုပ်ပါ။

## Chat slash commands

Chat message များသည် `/...` command များကို (text နှင့် native) ထောက်ပံ့ပေးပါသည်။ [/tools/slash-commands](/tools/slash-commands) ကို ကြည့်ပါ။

Highlights—

- `/status` — အမြန် စမ်းသပ်စစ်ဆေးမှုများအတွက်။
- `/config` — သိမ်းဆည်းထားသော config ပြောင်းလဲမှုများအတွက်။
- `/debug` — runtime သာ အကျိုးသက်ရောက်သော config override များအတွက် (memory သာ၊ disk မဟုတ်; `commands.debug: true` လိုအပ်သည်)။

## Setup + onboarding

### `setup`

config + workspace ကို စတင်အလုပ်လုပ်စေပါ။

Options—

- `--workspace <dir>`: agent workspace လမ်းကြောင်း (မူလ `~/.openclaw/workspace`)။
- `--wizard`: onboarding wizard ကို လည်ပတ်ပါ။
- `--non-interactive`: မေးခွန်းမရှိဘဲ wizard ကို လည်ပတ်ပါ။
- `--mode <local|remote>`: wizard မုဒ်။
- `--remote-url <url>`: အဝေးမှ Gateway URL။
- `--remote-token <token>`: အဝေးမှ Gateway token။

wizard flags များ (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`) တစ်ခုခု ပါဝင်လာပါက wizard သည် အလိုအလျောက် လည်ပတ်သည်။

### `onboard`

gateway၊ workspace နှင့် skills များကို တပ်ဆင်ရန် interactive wizard။

Options—

- `--workspace <dir>`
- `--reset` (wizard မတိုင်မီ config + credentials + sessions + workspace ကို ပြန်လည်သတ်မှတ်)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual သည် advanced ၏ alias)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (non-interactive; `--auth-choice token` နှင့်အတူ အသုံးပြုသည်)
- `--token <token>` (non-interactive; `--auth-choice token` နှင့်အတူ အသုံးပြုသည်)
- `--token-profile-id <id>` (non-interactive; မူလ: `<provider>:manual`)
- `--token-expires-in <duration>` (non-interactive; ဥပမာ `365d`, `12h`)
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
- `--no-install-daemon` (alias: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm ကို အကြံပြုသည်; Gateway runtime အတွက် bun ကို မအကြံပြုပါ)
- `--json`

### `configure`

Interactive configuration wizard (models, channels, skills, gateway)။

### `config`

non-interactive config helper များ (get/set/unset)။ `openclaw config` ကို subcommand မပါဘဲ run လုပ်ပါက wizard ကို စတင်ပေးပါသည်။

Subcommands—

- `config get <path>`: config တန်ဖိုးတစ်ခုကို ပုံနှိပ်ပါ (dot/bracket လမ်းကြောင်း)။
- `config set <path> <value>`: တန်ဖိုးတစ်ခုကို သတ်မှတ်ပါ (JSON5 သို့မဟုတ် raw string)။
- `config unset <path>`: တန်ဖိုးတစ်ခုကို ဖယ်ရှားပါ။

### `doctor`

ကျန်းမာရေး စစ်ဆေးမှုများ + အမြန် ပြုပြင်မှုများ (config + gateway + legacy services)။

Options—

- `--no-workspace-suggestions`: workspace memory အကြံပြုချက်များကို ပိတ်ပါ။
- `--yes`: မေးခွန်းမရှိဘဲ မူလတန်ဖိုးများကို လက်ခံပါ (headless)။
- `--non-interactive`: prompts များကို ကျော်လွှားပြီး safe migrations များကိုသာ လုပ်ဆောင်ပါ။
- `--deep`: system services များတွင် gateway ထပ်မံတပ်ဆင်ထားမှုများကို စကန်လုပ်ပါ။

## Channel helpers

### `channels`

chat channel အကောင့်များကို စီမံခန့်ခွဲပါ (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams)။

Subcommands—

- `channels list`: သတ်မှတ်ထားသော channels နှင့် auth profiles များကို ပြပါ။
- `channels status`: gateway ဆက်သွယ်နိုင်မှုနှင့် channel ကျန်းမာရေးကို စစ်ဆေးပါ (`--probe` သည် စစ်ဆေးမှုများ ထပ်တိုးလုပ်ဆောင်သည်; gateway ကျန်းမာရေး probe အတွက် `openclaw health` သို့မဟုတ် `openclaw status --deep` ကို အသုံးပြုပါ)။
- အကြံပြုချက်: `channels status` သည် တွေ့ရှိနိုင်သော သာမန် အမှားများအတွက် သတိပေးချက်များနှင့် အကြံပြု ပြုပြင်မှုများကို ပုံနှိပ်ပေးပြီး `openclaw doctor` သို့ ညွှန်ပြပါသည်။
- `channels logs`: gateway log ဖိုင်မှ မကြာသေးမီ channel logs များကို ပြပါ။
- `channels add`: flags မပါလျှင် wizard ပုံစံ setup; flags ပေးပါက non-interactive မုဒ်သို့ ပြောင်းသည်။
- `channels remove`: မူလအနေဖြင့် ပိတ်ထားသည်; prompts မရှိဘဲ config entries ကို ဖယ်ရှားရန် `--delete` ကို ပေးပါ။
- `channels login`: interactive channel login (WhatsApp Web သာ)။
- `channels logout`: channel session မှ logout လုပ်ပါ (ပံ့ပိုးပါက)။

Common options—

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: channel account id (မူလ `default`)
- `--name <label>`: အကောင့်အတွက် ပြသမည့် အမည်

`channels login` options—

- `--channel <channel>` (မူလ `whatsapp`; `whatsapp`/`web` ကို ပံ့ပိုး)
- `--account <id>`
- `--verbose`

`channels logout` options—

- `--channel <channel>` (မူလ `whatsapp`)
- `--account <id>`

`channels list` options—

- `--no-usage`: model provider အသုံးပြုမှု/ကန့်သတ်ချက် snapshot များကို ကျော်လွှားပါ (OAuth/API အခြေပြုသာ)။
- `--json`: JSON အဖြစ် ထုတ်ပါ (`--no-usage` မသတ်မှတ်ထားလျှင် အသုံးပြုမှု ပါဝင်သည်)။

`channels logs` options—

- `--channel <name|all>` (မူလ `all`)
- `--lines <n>` (မူလ `200`)
- `--json`

အသေးစိတ်— [/concepts/oauth](/concepts/oauth)

ဥပမာများ—

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

ရရှိနိုင်သော skills များနှင့် readiness အချက်အလက်များကို စာရင်းပြုစု၍ စစ်ဆေးပါ။

Subcommands—

- `skills list`: skills များကို စာရင်းပြုစုပါ (subcommand မရှိပါက မူလ)။
- `skills info <name>`: skill တစ်ခုအတွက် အသေးစိတ် ပြပါ။
- `skills check`: အဆင်သင့် vs လိုအပ်ချက် မပြည့်စုံမှု အကျဉ်းချုပ်။

Options—

- `--eligible`: အဆင်သင့်ဖြစ်သော skills များကိုသာ ပြပါ။
- `--json`: JSON အဖြစ် ထုတ်ပါ (styling မပါ)။
- `-v`, `--verbose`: လိုအပ်ချက် မပြည့်စုံမှု အသေးစိတ် ပါဝင်စေပါ။

အကြံပြုချက်: skills များကို ရှာဖွေ၊ ထည့်သွင်း၊ sync လုပ်ရန် `npx clawhub` ကို အသုံးပြုပါ။

### `pairing`

channel များအကြား DM pairing တောင်းဆိုမှုများကို အတည်ပြုပါ။

Subcommands—

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub hook setup နှင့် runner။ [/automation/gmail-pubsub](/automation/gmail-pubsub) ကို ကြည့်ပါ။

Subcommands—

- `webhooks gmail setup` ( `--account <email>` လိုအပ်; `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json` ကို ပံ့ပိုး)
- `webhooks gmail run` (တူညီသော flags များအတွက် runtime overrides)

### `dns setup`

Wide-area discovery DNS helper (CoreDNS + Tailscale)။ [/gateway/discovery](/gateway/discovery) ကို ကြည့်ပါ။

Options—

- `--apply`: CoreDNS config ကို ထည့်သွင်း/အပ်ဒိတ်လုပ်ပါ (sudo လိုအပ်; macOS သာ)။

## Messaging + agent

### `message`

ပေါင်းစည်းထားသော outbound messaging + channel actions။

ကြည့်ရန်— [/cli/message](/cli/message)

Subcommands—

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

ဥပမာများ—

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Gateway မှတစ်ဆင့် agent တစ်ကြိမ် လည်ပတ်ပါ (သို့မဟုတ် `--local` embedded)။

လိုအပ်သည်—

- `--message <text>`

Options—

- `--to <dest>` (session key နှင့် optional delivery အတွက်)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (GPT-5.2 + Codex မော်ဒယ်များသာ)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

သီးခြားထားသော agents များကို စီမံခန့်ခွဲပါ (workspaces + auth + routing)။

#### `agents list`

သတ်မှတ်ထားသော agents များကို စာရင်းပြုစုပါ။

Options—

- `--json`
- `--bindings`

#### `agents add [name]`

isolated agent အသစ်တစ်ခု ထည့်ပါ။ flag များ (သို့မဟုတ် `--non-interactive`) ကို မပေးထားပါက guided wizard ကို run လုပ်ပါသည်; non-interactive mode တွင် `--workspace` လိုအပ်ပါသည်။

Options—

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (ပြန်လည်ထပ်ခါ ပေးနိုင်သည်)
- `--non-interactive`
- `--json`

Binding spec များသည် `channel[:accountId]` ကို အသုံးပြုပါသည်။ WhatsApp အတွက် `accountId` ကို ချန်လှပ်ထားပါက default account id ကို အသုံးပြုပါသည်။

#### `agents delete <id>`

agent တစ်ခုကို ဖျက်ပြီး ၎င်း၏ workspace + state ကို သန့်စင်ပါ။

Options—

- `--force`
- `--json`

### `acp`

IDEs များကို Gateway နှင့် ချိတ်ဆက်ပေးသော ACP bridge ကို လည်ပတ်ပါ။

အသေးစိတ် ရွေးချယ်မှုများနှင့် ဥပမာများအတွက် [`acp`](/cli/acp) ကို ကြည့်ပါ။

### `status`

ချိတ်ဆက်ထားသော ဆက်ရှင် ကျန်းမာရေးနှင့် မကြာသေးမီ လက်ခံသူများကို ပြပါ။

Options—

- `--json`
- `--all` (ပြည့်စုံသော စမ်းသပ်စစ်ဆေးမှု; read-only, paste လုပ်နိုင်)
- `--deep` (channels များကို probe)
- `--usage` (model provider အသုံးပြုမှု/ကန့်သတ်ချက် ပြပါ)
- `--timeout <ms>`
- `--verbose`
- `--debug` ( `--verbose` ၏ alias)

မှတ်ချက်များ—

- Overview တွင် ရရှိနိုင်ပါက Gateway + node host service အခြေအနေကို ပါဝင်ပြသသည်။

### Usage tracking

OAuth/API အထောက်အထားများ ရှိပါက OpenClaw သည် provider အသုံးပြုမှု/ကန့်သတ်ချက်များကို ပြသနိုင်သည်။

Surfaces—

- `/status` (ရရှိနိုင်ပါက provider အသုံးပြုမှု အတိုချုပ် စာကြောင်းတစ်ကြောင်း ထည့်ပေါင်း)
- `openclaw status --usage` (provider အလိုက် ပြည့်စုံသော ခွဲခြမ်းစိတ်ဖြာချက်ကို ပုံနှိပ်)
- macOS menu bar (Context အောက်ရှိ Usage အပိုင်း)

မှတ်ချက်များ—

- ဒေတာသည် provider usage endpoint များမှ တိုက်ရိုက် ရယူသည် (ခန့်မှန်းချက် မရှိ)။
- Providers— Anthropic, GitHub Copilot, OpenAI Codex OAuth နှင့် provider plugin များ ဖွင့်ထားပါက Gemini CLI/Antigravity။
- ကိုက်ညီသော အထောက်အထား မရှိပါက အသုံးပြုမှုကို ဖျောက်ထားသည်။
- အသေးစိတ်— [Usage tracking](/concepts/usage-tracking) ကို ကြည့်ပါ။

### `health`

လည်ပတ်နေသော Gateway မှ ကျန်းမာရေးကို ရယူပါ။

Options—

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

သိမ်းဆည်းထားသော စကားပြော ဆက်ရှင်များကို စာရင်းပြုစုပါ။

Options—

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Reset / Uninstall

### `reset`

local config/state ကို ပြန်လည်သတ်မှတ်ပါ (CLI ကို မဖယ်ရှားပါ)။

Options—

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

မှတ်ချက်များ—

- `--non-interactive` သည် `--scope` နှင့် `--yes` ကို လိုအပ်သည်။

### `uninstall`

gateway service + local ဒေတာကို ဖယ်ရှားပါ (CLI ဆက်လက်ရှိနေသည်)။

Options—

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

မှတ်ချက်များ—

- `--non-interactive` သည် `--yes` နှင့် သတ်မှတ်ထားသော scopes (သို့မဟုတ် `--all`) ကို လိုအပ်သည်။

## Gateway

### `gateway`

WebSocket Gateway ကို လည်ပတ်ပါ။

Options—

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (dev config + credentials + sessions + workspace ကို ပြန်လည်သတ်မှတ်)
- `--force` (port ပေါ်ရှိ listener ရှိပြီးသားကို သတ်)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` ( `--ws-log compact` ၏ alias)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gateway service ကို စီမံခန့်ခွဲပါ (launchd/systemd/schtasks)။

Subcommands—

- `gateway status` (မူလအားဖြင့် Gateway RPC ကို probe)
- `gateway install` (service install)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

မှတ်ချက်များ—

- `gateway status` သည် service ၏ ဖြေရှင်းထားသော port/config ကို အသုံးပြု၍ မူလအားဖြင့် Gateway RPC ကို probe လုပ်သည် (`--url/--token/--password` ဖြင့် override လုပ်နိုင်)။
- `gateway status` သည် scripting အတွက် `--no-probe`, `--deep`, `--json` ကို ပံ့ပိုးသည်။
- `gateway status` သည် detect လုပ်နိုင်ပါက legacy သို့မဟုတ် extra gateway service များကိုပါ ဖော်ပြပေးပါသည် (`--deep` သည် system-level scan များကို ထည့်ပေါင်းပါသည်)။ profile အမည်ဖြင့် ခေါ်ထားသော OpenClaw service များကို first-class အဖြစ် သတ်မှတ်ပြီး “extra” ဟု မ flag လုပ်ပါ။
- `gateway status` သည် CLI အသုံးပြုနေသော config လမ်းကြောင်းနှင့် service အသုံးပြုနိုင်ခြေရှိသော config (service env) ကို နှိုင်းယှဉ်ပုံနှိပ်ပြီး probe target URL ကို ပြပါသည်။
- `gateway install|uninstall|start|stop|restart` သည် scripting အတွက် `--json` ကို ပံ့ပိုးသည် (မူလ output သည် လူဖတ်ရလွယ်ကူနေသည်)။
- `gateway install` သည် Node runtime ကို မူလအသုံးပြုသည်; bun ကို **မအကြံပြုပါ** (WhatsApp/Telegram bugs)။
- `gateway install` options— `--port`, `--runtime`, `--token`, `--force`, `--json`။

### `logs`

RPC မှတစ်ဆင့် Gateway ဖိုင် logs များကို tail လုပ်ပါ။

မှတ်ချက်များ—

- TTY ဆက်ရှင်များတွင် အရောင်ပါ structured view ကို ပြသသည်; non-TTY တွင် ရိုးရိုးစာသားသို့ ပြန်လည်ကျသွားသည်။
- `--json` သည် line-delimited JSON ကို ထုတ်ပေးသည် (စာကြောင်းတစ်ကြောင်းလျှင် log event တစ်ခု)။

ဥပမာများ—

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI helper များ (RPC subcommand များအတွက် `--url`, `--token`, `--password`, `--timeout`, `--expect-final` ကို အသုံးပြုပါ)။
`--url` ကို ပေးလိုက်ပါက CLI သည် config သို့မဟုတ် environment credential များကို auto-apply မလုပ်ပါ။
`--token` သို့မဟုတ် `--password` ကို ထည့်သွင်းပါ။ credential ကို တိတိကျကျ မပေးထားပါက error ဖြစ်ပါသည်။

Subcommands—

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Common RPCs—

- `config.apply` (validate + write config + restart + wake)
- `config.patch` (partial update ကို merge + restart + wake)
- `update.run` (update ကို run + restart + wake)

အကြံပြုချက်: `config.set`/`config.apply`/`config.patch` ကို တိုက်ရိုက် ခေါ်သုံးပါက
config ရှိပြီးသားဖြစ်လျှင် `config.get` မှ `baseHash` ကို ပေးပါ။

## Models

fallback အပြုအမူနှင့် scanning မဟာဗျူဟာအတွက် [/concepts/models](/concepts/models) ကို ကြည့်ပါ။

အကြံပြုထားသော Anthropic auth (setup-token)—

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (root)

`openclaw models` သည် `models status` ၏ alias ဖြစ်သည်။

Root options—

- `--status-json` ( `models status --json` ၏ alias)
- `--status-plain` ( `models status --plain` ၏ alias)

### `models list`

Options—

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Options—

- `--json`
- `--plain`
- `--check` (exit 1=သက်တမ်းကုန်/မရှိ, 2=မကြာမီကုန်)
- `--probe` (သတ်မှတ်ထားသော auth profiles များကို တိုက်ရိုက် probe)
- `--probe-provider <name>`
- `--probe-profile <id>` (ထပ်ခါ သို့မဟုတ် comma ဖြင့် ခွဲထား)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

auth store ထဲရှိ profile များအတွက် auth overview နှင့် OAuth expiry status ကို အမြဲတမ်း ထည့်သွင်းပြသပါသည်။
`--probe` သည် live request များကို run လုပ်ပါသည် (token များကို သုံးစွဲနိုင်ပြီး rate limit ကို trigger ဖြစ်စေနိုင်ပါသည်)။

### `models set <model>`

`agents.defaults.model.primary` ကို သတ်မှတ်ပါ။

### `models set-image <model>`

`agents.defaults.imageModel.primary` ကို သတ်မှတ်ပါ။

### `models aliases list|add|remove`

Options—

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Options—

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Options—

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Options—

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

Options—

- `add`: interactive auth အကူအညီ
- `setup-token`: `--provider <name>` (မူလ `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Options—

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

system event တစ်ခုကို enqueue လုပ်ပြီး (ရွေးချယ်နိုင်သည့်အနေဖြင့်) heartbeat ကို လှုံ့ဆော်ပါ (Gateway RPC)။

လိုအပ်သည်—

- `--text <text>`

Options—

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat ထိန်းချုပ်မှုများ (Gateway RPC)။

Options—

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

system presence entries များကို စာရင်းပြုစုပါ (Gateway RPC)။

Options—

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

scheduled job များကို စီမံခန့်ခွဲပါ (Gateway RPC)။ [/automation/cron-jobs](/automation/cron-jobs) ကို ကြည့်ပါ။

Subcommands—

- `cron status [--json]`
- `cron list [--all] [--json]` (မူလအားဖြင့် ဇယား output; raw အတွက် `--json` ကို အသုံးပြု)
- `cron add` (alias: `create`; `--name` နှင့် `--at` | `--every` | `--cron` တစ်ခုတည်းသာ လိုအပ်ပြီး payload `--system-event` | `--message` ထဲမှ တစ်ခုတည်းသာ လိုအပ်)
- `cron edit <id>` (fields များကို patch)
- `cron rm <id>` (aliases: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

`cron` အမိန့်အားလုံးသည် `--url`, `--token`, `--timeout`, `--expect-final` ကို လက်ခံသည်။

## Node host

`node` သည် **headless node host** ကို run လုပ်ခြင်း သို့မဟုတ် background service အဖြစ် စီမံခန့်ခွဲပါသည်။ [`openclaw node`](/cli/node) ကို ကြည့်ပါ။

Subcommands—

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`nodes` သည် Gateway နှင့် ဆက်သွယ်ပြီး paired node များကို target လုပ်ပါသည်။ [/nodes](/nodes) ကို ကြည့်ပါ။

Common options—

- `--url`, `--token`, `--timeout`, `--json`

Subcommands—

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac node သို့မဟုတ် headless node host)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac သာ)

Camera—

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + screen—

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Location—

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Browser

Browser control CLI (သီးသန့် Chrome/Brave/Edge/Chromium)။ [`openclaw browser`](/cli/browser) နှင့် [Browser tool](/tools/browser) ကို ကြည့်ပါ။

Common options—

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Manage—

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

Inspect—

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Actions—

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

လက်ရှိ docs index ကို ရှာဖွေပါ။

## TUI

### `tui`

Gateway နှင့် ချိတ်ဆက်ထားသော terminal UI ကို ဖွင့်ပါ။

Options—

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (မူလ `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
