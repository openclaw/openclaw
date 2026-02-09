---
summary: "openclaw کمانڈز، ذیلی کمانڈز، اور اختیارات کے لیے OpenClaw CLI حوالہ"
read_when:
  - CLI کمانڈز یا اختیارات شامل یا تبدیل کرتے وقت
  - نئی کمانڈ سرفیسز کی دستاویز بندی کرتے وقت
title: "CLI حوالہ"
---

# CLI حوالہ

This page describes the current CLI behavior. If commands change, update this doc.

## کمانڈ صفحات

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
- [`plugins`](/cli/plugins) (پلگ اِن کمانڈز)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (پلگ اِن؛ اگر انسٹال ہو)

## عالمی فلیگز

- `--dev`: حالت کو `~/.openclaw-dev` کے تحت علیحدہ کریں اور طے شدہ پورٹس منتقل کریں۔
- `--profile <name>`: حالت کو `~/.openclaw-<name>` کے تحت علیحدہ کریں۔
- `--no-color`: ANSI رنگ غیر فعال کریں۔
- `--update`: `openclaw update` کا مختصر روپ (صرف سورس انسٹالز)۔
- `-V`, `--version`, `-v`: ورژن پرنٹ کریں اور خارج ہوں۔

## آؤٹ پٹ اسٹائلنگ

- ANSI رنگ اور پیش رفت کے اشاریے صرف TTY سیشنز میں رینڈر ہوتے ہیں۔
- OSC-8 ہائپر لنکس معاون ٹرمینلز میں قابلِ کلک لنکس کے طور پر رینڈر ہوتے ہیں؛ بصورتِ دیگر ہم سادہ URLs پر واپس آتے ہیں۔
- `--json` (اور جہاں معاون ہو `--plain`) صاف آؤٹ پٹ کے لیے اسٹائلنگ غیر فعال کرتا ہے۔
- `--no-color` ANSI اسٹائلنگ غیر فعال کرتا ہے؛ `NO_COLOR=1` کو بھی مدِنظر رکھا جاتا ہے۔
- طویل المدت کمانڈز پیش رفت کا اشاریہ دکھاتی ہیں (OSC 9;4 جہاں معاون ہو)۔

## رنگوں کا پیلیٹ

OpenClaw CLI آؤٹ پٹ کے لیے lobster پیلیٹ استعمال کرتا ہے۔

- `accent` (#FF5A2D): سرخیاں، لیبلز، بنیادی ہائی لائٹس۔
- `accentBright` (#FF7A3D): کمانڈ نام، زور۔
- `accentDim` (#D14A22): ثانوی ہائی لائٹ متن۔
- `info` (#FF8A5B): معلوماتی اقدار۔
- `success` (#2FBF71): کامیابی کی حالتیں۔
- `warn` (#FFB020): انتباہات، فال بیکس، توجہ۔
- `error` (#E23D2D): غلطیاں، ناکامیاں۔
- `muted` (#8B7F77): کم زور نمایاں کرنا، میٹا ڈیٹا۔

پیلیٹ کا مستند ماخذ: `src/terminal/palette.ts` (عرف “lobster seam”)۔

## کمانڈ درخت

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

نوٹ: پلگ اِنز اضافی اعلیٰ سطحی کمانڈز شامل کر سکتے ہیں (مثلاً `openclaw voicecall`)۔

## سکیورٹی

- `openclaw security audit` — عام سکیورٹی خامیوں کے لیے کنفیگ + مقامی حالت کا آڈٹ۔
- `openclaw security audit --deep` — بہترین کوشش کے ساتھ لائیو Gateway پروب۔
- `openclaw security audit --fix` — محفوظ طے شدہ اقدار کو سخت کریں اور state/config پر chmod کریں۔

## پلگ اِنز

ایکسٹینشنز اور ان کی کنفیگ کا انتظام کریں:

- `openclaw plugins list` — پلگ اِنز دریافت کریں (مشینی آؤٹ پٹ کے لیے `--json` استعمال کریں)۔
- `openclaw plugins info <id>` — کسی پلگ اِن کی تفصیلات دکھائیں۔
- `openclaw plugins install <path|.tgz|npm-spec>` — پلگ اِن انسٹال کریں (یا پلگ اِن پاتھ کو `plugins.load.paths` میں شامل کریں)۔
- `openclaw plugins enable <id>` / `disable <id>` — toggle `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — پلگ اِن لوڈ کی غلطیوں کی رپورٹ۔

Most plugin changes require a gateway restart. See [/plugin](/tools/plugin).

## میموری

`MEMORY.md` + `memory/*.md` پر ویکٹر سرچ:

- `openclaw memory status` — انڈیکس کے اعداد و شمار دکھائیں۔
- `openclaw memory index` — میموری فائلز کو دوبارہ انڈیکس کریں۔
- `openclaw memory search "<query>"` — میموری پر معنوی تلاش۔

## چیٹ سلیش کمانڈز

Chat messages support `/...` commands (text and native). See [/tools/slash-commands](/tools/slash-commands).

نمایاں نکات:

- فوری تشخیص کے لیے `/status`۔
- مستقل کنفیگ تبدیلیوں کے لیے `/config`۔
- صرف رَن ٹائم کنفیگ اوور رائیڈز کے لیے `/debug` (میموری، ڈسک نہیں؛ `commands.debug: true` درکار)۔

## سیٹ اپ + آن بورڈنگ

### `setup`

کنفیگ + ورک اسپیس کو ابتدائی بنائیں۔

اختیارات:

- `--workspace <dir>`: ایجنٹ ورک اسپیس پاتھ (طے شدہ `~/.openclaw/workspace`)۔
- `--wizard`: آن بورڈنگ وزارڈ چلائیں۔
- `--non-interactive`: پرامپٹس کے بغیر وزارڈ چلائیں۔
- `--mode <local|remote>`: وزارڈ موڈ۔
- `--remote-url <url>`: ریموٹ Gateway URL۔
- `--remote-token <token>`: ریموٹ Gateway ٹوکن۔

جب کوئی بھی وزارڈ فلیگ موجود ہو (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`) تو وزارڈ خود بخود چلتا ہے۔

### `onboard`

گیٹ وے، ورک اسپیس، اور skills سیٹ اپ کرنے کے لیے انٹرایکٹو وزارڈ۔

اختیارات:

- `--workspace <dir>`
- `--reset` (وزارڈ سے پہلے کنفیگ + اسناد + سیشنز + ورک اسپیس ری سیٹ کریں)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual، advanced کا عرف ہے)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (نان-انٹرایکٹو؛ `--auth-choice token` کے ساتھ استعمال)
- `--token <token>` (نان-انٹرایکٹو؛ `--auth-choice token` کے ساتھ استعمال)
- `--token-profile-id <id>` (نان-انٹرایکٹو؛ طے شدہ: `<provider>:manual`)
- `--token-expires-in <duration>` (نان-انٹرایکٹو؛ مثلاً `365d`, `12h`)
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
- `--no-install-daemon` (عرف: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm سفارش کردہ؛ Gateway رن ٹائم کے لیے bun سفارش نہیں)
- `--json`

### `configure`

انٹرایکٹو کنفیگریشن وزارڈ (ماڈلز، چینلز، skills، gateway)۔

### `config`

Non-interactive config helpers (get/set/unset). Running `openclaw config` with no
subcommand launches the wizard.

ذیلی کمانڈز:

- `config get <path>`: کنفیگ ویلیو پرنٹ کریں (ڈاٹ/بریکٹ پاتھ)۔
- `config set <path> <value>`: ویلیو سیٹ کریں (JSON5 یا خام سٹرنگ)۔
- `config unset <path>`: ویلیو ہٹائیں۔

### `doctor`

صحت کی جانچ + فوری اصلاحات (کنفیگ + gateway + لیگیسی سروسز)۔

اختیارات:

- `--no-workspace-suggestions`: ورک اسپیس میموری اشارے غیر فعال کریں۔
- `--yes`: بغیر پرامپٹ کے طے شدہ اقدار قبول کریں (ہیڈ لیس)۔
- `--non-interactive`: پرامپٹس چھوڑ دیں؛ صرف محفوظ مائیگریشنز لاگو کریں۔
- `--deep`: اضافی gateway انسٹالز کے لیے سسٹم سروسز اسکین کریں۔

## چینل مددگار

### `channels`

چیٹ چینل اکاؤنٹس کا انتظام کریں (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (پلگ اِن)/Signal/iMessage/MS Teams)۔

ذیلی کمانڈز:

- `channels list`: کنفیگر شدہ چینلز اور auth پروفائلز دکھائیں۔
- `channels status`: gateway کی رسائی اور چینل صحت چیک کریں (`--probe` اضافی چیکس چلاتا ہے؛ gateway صحت پروبز کے لیے `openclaw health` یا `openclaw status --deep` استعمال کریں)۔
- مشورہ: `channels status` عام غلط کنفیگریشنز کی نشاندہی پر تجویز کردہ حل کے ساتھ انتباہات پرنٹ کرتا ہے (پھر آپ کو `openclaw doctor` کی طرف بھیجتا ہے)۔
- `channels logs`: gateway لاگ فائل سے حالیہ چینل لاگز دکھائیں۔
- `channels add`: جب کوئی فلیگ نہ ہو تو وزارڈ طرز کا سیٹ اپ؛ فلیگز نان-انٹرایکٹو موڈ پر سوئچ کرتے ہیں۔
- `channels remove`: بطورِ طے شدہ غیر فعال؛ بغیر پرامپٹس کنفیگ اندراجات ہٹانے کے لیے `--delete` پاس کریں۔
- `channels login`: انٹرایکٹو چینل لاگ اِن (صرف WhatsApp Web)۔
- `channels logout`: چینل سیشن سے لاگ آؤٹ کریں (اگر معاون ہو)۔

عام اختیارات:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: چینل اکاؤنٹ آئی ڈی (طے شدہ `default`)
- `--name <label>`: اکاؤنٹ کے لیے ڈسپلے نام

`channels login` اختیارات:

- `--channel <channel>` (طے شدہ `whatsapp`; `whatsapp`/`web` کی حمایت)
- `--account <id>`
- `--verbose`

`channels logout` اختیارات:

- `--channel <channel>` (طے شدہ `whatsapp`)
- `--account <id>`

`channels list` اختیارات:

- `--no-usage`: ماڈل فراہم کنندہ کے استعمال/کوٹا اسنیپ شاٹس چھوڑ دیں (صرف OAuth/API بیکڈ)۔
- `--json`: JSON آؤٹ پٹ (استعمال شامل ہوتا ہے جب تک `--no-usage` سیٹ نہ ہو)۔

`channels logs` اختیارات:

- `--channel <name|all>` (طے شدہ `all`)
- `--lines <n>` (طے شدہ `200`)
- `--json`

مزید تفصیل: [/concepts/oauth](/concepts/oauth)

مثالیں:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

دستیاب skills اور تیاری کی معلومات کی فہرست اور معائنہ کریں۔

ذیلی کمانڈز:

- `skills list`: skills کی فہرست (جب کوئی ذیلی کمانڈ نہ ہو تو طے شدہ)۔
- `skills info <name>`: ایک skill کی تفصیلات دکھائیں۔
- `skills check`: تیار بمقابلہ غائب تقاضوں کا خلاصہ۔

اختیارات:

- `--eligible`: صرف تیار skills دکھائیں۔
- `--json`: JSON آؤٹ پٹ (بغیر اسٹائلنگ)۔
- `-v`, `--verbose`: غائب تقاضوں کی تفصیل شامل کریں۔

مشورہ: skills تلاش، انسٹال، اور سنک کرنے کے لیے `npx clawhub` استعمال کریں۔

### `pairing`

چینلز کے پار DM pairing درخواستوں کی منظوری دیں۔

ذیلی کمانڈز:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub hook setup + runner. See [/automation/gmail-pubsub](/automation/gmail-pubsub).

ذیلی کمانڈز:

- `webhooks gmail setup` (درکار `--account <email>`; `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json` کی حمایت)
- `webhooks gmail run` (اسی فلیگز کے لیے رن ٹائم اوور رائیڈز)

### `dns setup`

Wide-area discovery DNS helper (CoreDNS + Tailscale). See [/gateway/discovery](/gateway/discovery).

اختیارات:

- `--apply`: CoreDNS کنفیگ انسٹال/اپ ڈیٹ کریں (sudo درکار؛ صرف macOS)۔

## میسجنگ + ایجنٹ

### `message`

متحدہ آؤٹ باؤنڈ میسجنگ + چینل ایکشنز۔

دیکھیں: [/cli/message](/cli/message)

ذیلی کمانڈز:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

مثالیں:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Gateway کے ذریعے ایک ایجنٹ ٹرن چلائیں (یا `--local` ایمبیڈڈ)۔

درکار:

- `--message <text>`

اختیارات:

- `--to <dest>` (سیشن کی اور اختیاری ڈیلیوری کے لیے)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (صرف GPT-5.2 + Codex ماڈلز)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

الگ تھلگ ایجنٹس کا انتظام کریں (ورک اسپیسز + auth + روٹنگ)۔

#### `agents list`

کنفیگر شدہ ایجنٹس کی فہرست۔

اختیارات:

- `--json`
- `--bindings`

#### `agents add [name]`

ایک نیا الگ تھلگ ایجنٹ شامل کریں۔ جب تک فلیگز (یا `--non-interactive`) فراہم نہ کیے جائیں، رہنمائی والا وزرڈ چلتا ہے؛ نان اِنٹریکٹو موڈ میں `--workspace` درکار ہے۔

اختیارات:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (دہرایا جا سکتا ہے)
- `--non-interactive`
- `--json`

بائنڈنگ اسپیسیفکیشنز `channel[:accountId]` استعمال کرتی ہیں۔ جب WhatsApp کے لیے `accountId` چھوڑ دیا جائے تو ڈیفالٹ اکاؤنٹ آئی ڈی استعمال ہوتی ہے۔

#### `agents delete <id>`

ایجنٹ حذف کریں اور اس کی ورک اسپیس + حالت صاف کریں۔

اختیارات:

- `--force`
- `--json`

### `acp`

IDEز کو Gateway سے جوڑنے والا ACP برج چلائیں۔

مکمل اختیارات اور مثالوں کے لیے [`acp`](/cli/acp) دیکھیں۔

### `status`

منسلک سیشن صحت اور حالیہ وصول کنندگان دکھائیں۔

اختیارات:

- `--json`
- `--all` (مکمل تشخیص؛ صرف پڑھنے کے لیے، پیسٹ کے قابل)
- `--deep` (چینلز پروب کریں)
- `--usage` (ماڈل فراہم کنندہ کا استعمال/کوٹا دکھائیں)
- `--timeout <ms>`
- `--verbose`
- `--debug` (عرف `--verbose`)

نوٹس:

- جائزہ میں Gateway + نوڈ ہوسٹ سروس کی حالت شامل ہوتی ہے جب دستیاب ہو۔

### استعمال کی ٹریکنگ

جب OAuth/API اسناد دستیاب ہوں تو OpenClaw فراہم کنندہ کے استعمال/کوٹا کو ظاہر کر سکتا ہے۔

سرفیسز:

- `/status` (دستیاب ہونے پر مختصر استعمال لائن شامل کرتا ہے)
- `openclaw status --usage` (مکمل فراہم کنندہ بریک ڈاؤن پرنٹ کرتا ہے)
- macOS مینو بار (Context کے تحت Usage سیکشن)

نوٹس:

- ڈیٹا براہِ راست فراہم کنندہ کے استعمال اینڈ پوائنٹس سے آتا ہے (کوئی اندازے نہیں)۔
- فراہم کنندگان: Anthropic، GitHub Copilot، OpenAI Codex OAuth، نیز Gemini CLI/Antigravity جب وہ فراہم کنندہ پلگ اِنز فعال ہوں۔
- اگر مماثل اسناد موجود نہ ہوں تو استعمال مخفی رہتا ہے۔
- تفصیلات: دیکھیں [Usage tracking](/concepts/usage-tracking)۔

### `health`

چلتے ہوئے Gateway سے صحت حاصل کریں۔

اختیارات:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

محفوظ شدہ گفتگو سیشنز کی فہرست۔

اختیارات:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## ری سیٹ / اَن انسٹال

### `reset`

مقامی کنفیگ/حالت ری سیٹ کریں (CLI انسٹال رہتی ہے)۔

اختیارات:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

نوٹس:

- `--non-interactive` کے لیے `--scope` اور `--yes` درکار ہیں۔

### `uninstall`

gateway سروس + مقامی ڈیٹا اَن انسٹال کریں (CLI برقرار رہتی ہے)۔

اختیارات:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

نوٹس:

- `--non-interactive` کے لیے `--yes` اور واضح اسکوپس (یا `--all`) درکار ہیں۔

## Gateway

### `gateway`

WebSocket Gateway چلائیں۔

اختیارات:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (ڈیولپمنٹ کنفیگ + اسناد + سیشنز + ورک اسپیس ری سیٹ کریں)
- `--force` (پورٹ پر موجودہ لسٹنر ختم کریں)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (عرف `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gateway سروس کا انتظام کریں (launchd/systemd/schtasks)۔

ذیلی کمانڈز:

- `gateway status` (بطورِ طے شدہ Gateway RPC پروب کرتا ہے)
- `gateway install` (سروس انسٹال)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

نوٹس:

- `gateway status` بطورِ طے شدہ سروس کے حل شدہ پورٹ/کنفیگ کا استعمال کرتے ہوئے Gateway RPC پروب کرتا ہے (`--url/--token/--password` سے اوور رائیڈ کریں)۔
- `gateway status` اسکرپٹنگ کے لیے `--no-probe`, `--deep`, اور `--json` کی حمایت کرتا ہے۔
- `gateway status` جب ممکن ہو تو لیگیسی یا اضافی گیٹ وے سروسز بھی ظاہر کرتا ہے (`--deep` سسٹم لیول اسکینز شامل کرتا ہے)۔ Profile-named OpenClaw services are treated as first-class and aren't flagged as "extra".
- `gateway status` دکھاتا ہے کہ CLI کون سا کنفیگ پاتھ استعمال کرتا ہے بمقابلہ سروس غالباً کون سا کنفیگ استعمال کرتی ہے (سروس env)، نیز حل شدہ پروب ٹارگٹ URL۔
- `gateway install|uninstall|start|stop|restart` اسکرپٹنگ کے لیے `--json` کی حمایت کرتا ہے (طے شدہ آؤٹ پٹ انسان دوست رہتا ہے)۔
- `gateway install` بطورِ طے شدہ Node رن ٹائم استعمال کرتا ہے؛ bun **سفارش نہیں** (WhatsApp/Telegram بگز)۔
- `gateway install` اختیارات: `--port`, `--runtime`, `--token`, `--force`, `--json`۔

### `logs`

RPC کے ذریعے Gateway فائل لاگز کو ٹیل کریں۔

نوٹس:

- TTY سیشنز رنگین، ساختہ منظر دکھاتے ہیں؛ نان-TTY سادہ متن پر واپس آتا ہے۔
- `--json` لائن-ڈلیمٹڈ JSON خارج کرتا ہے (ہر لائن پر ایک لاگ ایونٹ)۔

مثالیں:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

گیٹ وے CLI ہیلپرز (RPC سب کمانڈز کے لیے `--url`, `--token`, `--password`, `--timeout`, `--expect-final` استعمال کریں)۔
When you pass `--url`, the CLI does not auto-apply config or environment credentials.
Include `--token` or `--password` explicitly. Missing explicit credentials is an error.

ذیلی کمانڈز:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

عام RPCs:

- `config.apply` (تصدیق + کنفیگ لکھائی + ری اسٹارٹ + ویک)
- `config.patch` (جزوی اپ ڈیٹ مرج + ری اسٹارٹ + ویک)
- `update.run` (اپ ڈیٹ چلائیں + ری اسٹارٹ + ویک)

مشورہ: `config.set`/`config.apply`/`config.patch` کو براہِ راست کال کرتے وقت،
اگر کنفیگ پہلے سے موجود ہو تو `config.get` سے `baseHash` پاس کریں۔

## ماڈلز

فال بیک رویّے اور اسکیننگ حکمتِ عملی کے لیے [/concepts/models](/concepts/models) دیکھیں۔

ترجیحی Anthropic auth (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (روٹ)

`openclaw models`، `models status` کا عرف ہے۔

روٹ اختیارات:

- `--status-json` (عرف `models status --json`)
- `--status-plain` (عرف `models status --plain`)

### `models list`

اختیارات:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

اختیارات:

- `--json`
- `--plain`
- `--check` (خروج 1=میعاد ختم/غائب، 2=ختم ہونے کے قریب)
- `--probe` (کنفیگر شدہ auth پروفائلز کی لائیو پروب)
- `--probe-provider <name>`
- `--probe-profile <id>` (دہرائیں یا کوما سے جدا)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Always includes the auth overview and OAuth expiry status for profiles in the auth store.
`--probe` لائیو درخواستیں چلاتا ہے (ٹوکن خرچ ہو سکتے ہیں اور ریٹ لمٹس ٹرگر ہو سکتی ہیں)۔

### `models set <model>`

`agents.defaults.model.primary` سیٹ کریں۔

### `models set-image <model>`

`agents.defaults.imageModel.primary` سیٹ کریں۔

### `models aliases list|add|remove`

اختیارات:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

اختیارات:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

اختیارات:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

اختیارات:

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

اختیارات:

- `add`: انٹرایکٹو auth مددگار
- `setup-token`: `--provider <name>` (طے شدہ `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

اختیارات:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## سسٹم

### `system event`

سسٹم ایونٹ قطار میں ڈالیں اور اختیاری طور پر ہارٹ بیٹ ٹرگر کریں (Gateway RPC)۔

درکار:

- `--text <text>`

اختیارات:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

ہارٹ بیٹ کنٹرولز (Gateway RPC)۔

اختیارات:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

سسٹم موجودگی اندراجات کی فہرست (Gateway RPC)۔

اختیارات:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## کرون

شیڈول شدہ جابز کا انتظام کریں (Gateway RPC)۔ 1. دیکھیں [/automation/cron-jobs](/automation/cron-jobs).

ذیلی کمانڈز:

- `cron status [--json]`
- `cron list [--all] [--json]` (بطورِ طے شدہ ٹیبل آؤٹ پٹ؛ خام کے لیے `--json` استعمال کریں)
- `cron add` (عرف: `create`; `--name` درکار اور بالکل ایک `--at` | `--every` | `--cron`، اور بالکل ایک پے لوڈ `--system-event` | `--message`)
- `cron edit <id>` (فیلڈز پیچ کریں)
- `cron rm <id>` (عرفات: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

تمام `cron` کمانڈز `--url`, `--token`, `--timeout`, `--expect-final` قبول کرتی ہیں۔

## نوڈ ہوسٹ

`node` ایک **ہیڈلیس نوڈ ہوسٹ** چلاتا ہے یا اسے بیک گراؤنڈ سروس کے طور پر منظم کرتا ہے۔ دیکھیں
[`openclaw node`](/cli/node)۔

ذیلی کمانڈز:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## نوڈز

`nodes` گیٹ وے سے بات کرتا ہے اور جوڑے گئے نوڈز کو ہدف بناتا ہے۔ دیکھیں [/nodes](/nodes)۔

عام اختیارات:

- `--url`, `--token`, `--timeout`, `--json`

ذیلی کمانڈز:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac نوڈ یا ہیڈ لیس نوڈ ہوسٹ)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (صرف mac)

کیمرہ:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

کینوس + اسکرین:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

لوکیشن:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## براؤزر

براؤزر کنٹرول CLI (مخصوص Chrome/Brave/Edge/Chromium)۔ دیکھیں [`openclaw browser`](/cli/browser) اور [Browser tool](/tools/browser)۔

عام اختیارات:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

انتظام:

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

معائنہ:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

ایکشنز:

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

## دستاویزات تلاش

### `docs [query...]`

لائیو ڈاکس انڈیکس میں تلاش کریں۔

## TUI

### `tui`

Gateway سے منسلک ٹرمینل UI کھولیں۔

اختیارات:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (طے شدہ `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
