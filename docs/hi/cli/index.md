---
summary: "`openclaw` कमांड, उप-कमांड और विकल्पों के लिए OpenClaw CLI संदर्भ"
read_when:
  - CLI कमांड या विकल्प जोड़ते या संशोधित करते समय
  - नए कमांड सरफेस का दस्तावेज़ीकरण करते समय
title: "CLI संदर्भ"
---

# CLI संदर्भ

This page describes the current CLI behavior. If commands change, update this doc.

## कमांड पृष्ठ

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
- [`plugins`](/cli/plugins) (प्लगइन कमांड)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (प्लगइन; यदि इंस्टॉल हो)

## वैश्विक फ़्लैग

- `--dev`: `~/.openclaw-dev` के अंतर्गत स्थिति को अलग करें और डिफ़ॉल्ट पोर्ट बदलें।
- `--profile <name>`: `~/.openclaw-<name>` के अंतर्गत स्थिति को अलग करें।
- `--no-color`: ANSI रंग अक्षम करें।
- `--update`: `openclaw update` के लिए शॉर्टहैंड (केवल स्रोत इंस्टॉल)।
- `-V`, `--version`, `-v`: संस्करण प्रिंट करें और बाहर निकलें।

## आउटपुट स्टाइलिंग

- ANSI रंग और प्रगति संकेतक केवल TTY सत्रों में रेंडर होते हैं।
- OSC-8 हाइपरलिंक समर्थित टर्मिनलों में क्लिक करने योग्य लिंक के रूप में रेंडर होते हैं; अन्यथा हम साधारण URL पर वापस जाते हैं।
- `--json` (और जहाँ समर्थित हो वहाँ `--plain`) साफ आउटपुट के लिए स्टाइलिंग अक्षम करता है।
- `--no-color` ANSI स्टाइलिंग अक्षम करता है; `NO_COLOR=1` भी सम्मानित किया जाता है।
- लंबे समय तक चलने वाले कमांड प्रगति संकेतक दिखाते हैं (OSC 9;4 जहाँ समर्थित हो)।

## रंग पैलेट

OpenClaw CLI आउटपुट के लिए लॉब्स्टर पैलेट का उपयोग करता है।

- `accent` (#FF5A2D): शीर्षक, लेबल, प्राथमिक हाइलाइट।
- `accentBright` (#FF7A3D): कमांड नाम, जोर।
- `accentDim` (#D14A22): द्वितीयक हाइलाइट पाठ।
- `info` (#FF8A5B): सूचनात्मक मान।
- `success` (#2FBF71): सफलता अवस्थाएँ।
- `warn` (#FFB020): चेतावनियाँ, फ़ॉलबैक, ध्यान।
- `error` (#E23D2D): त्रुटियाँ, विफलताएँ।
- `muted` (#8B7F77): डी-एम्फ़ेसिस, मेटाडेटा।

पैलेट का स्रोत सत्य: `src/terminal/palette.ts` (उर्फ़ “lobster seam”)।

## कमांड ट्री

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

टिप्पणी: प्लगइन अतिरिक्त शीर्ष-स्तरीय कमांड जोड़ सकते हैं (उदाहरण के लिए `openclaw voicecall`)।

## सुरक्षा

- `openclaw security audit` — सामान्य सुरक्षा फ़ुट-गन के लिए कॉन्फ़िग + स्थानीय स्थिति का ऑडिट।
- `openclaw security audit --deep` — सर्वोत्तम-प्रयास लाइव Gateway प्रोब।
- `openclaw security audit --fix` — सुरक्षित डिफ़ॉल्ट कड़े करें और स्थिति/कॉन्फ़िग पर chmod लागू करें।

## प्लगइन्स

एक्सटेंशन और उनके कॉन्फ़िग का प्रबंधन करें:

- `openclaw plugins list` — प्लगइन खोजें (मशीन आउटपुट के लिए `--json` का उपयोग करें)।
- `openclaw plugins info <id>` — किसी प्लगइन का विवरण दिखाएँ।
- `openclaw plugins install <path|.tgz|npm-spec>` — प्लगइन इंस्टॉल करें (या `plugins.load.paths` में प्लगइन पथ जोड़ें)।
- `openclaw plugins enable <id>` / `disable <id>` — toggle `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — प्लगइन लोड त्रुटियों की रिपोर्ट करें।

Most plugin changes require a gateway restart. See [/plugin](/tools/plugin).

## मेमोरी

`MEMORY.md` + `memory/*.md` पर वेक्टर खोज:

- `openclaw memory status` — इंडेक्स आँकड़े दिखाएँ।
- `openclaw memory index` — मेमोरी फ़ाइलों को पुनः इंडेक्स करें।
- `openclaw memory search "<query>"` — मेमोरी पर सिमैंटिक खोज।

## चैट स्लैश कमांड

Chat messages support `/...` commands (text and native). See [/tools/slash-commands](/tools/slash-commands).

हाइलाइट्स:

- त्वरित डायग्नोस्टिक्स के लिए `/status`।
- स्थायी कॉन्फ़िग परिवर्तनों के लिए `/config`।
- केवल रनटाइम कॉन्फ़िग ओवरराइड के लिए `/debug` (मेमोरी, डिस्क नहीं; `commands.debug: true` आवश्यक)।

## सेटअप + ऑनबोर्डिंग

### `setup`

कॉन्फ़िग + वर्कस्पेस प्रारंभ करें।

विकल्प:

- `--workspace <dir>`: एजेंट वर्कस्पेस पथ (डिफ़ॉल्ट `~/.openclaw/workspace`)।
- `--wizard`: ऑनबोर्डिंग विज़ार्ड चलाएँ।
- `--non-interactive`: बिना प्रॉम्प्ट के विज़ार्ड चलाएँ।
- `--mode <local|remote>`: विज़ार्ड मोड।
- `--remote-url <url>`: रिमोट Gateway URL।
- `--remote-token <token>`: रिमोट Gateway टोकन।

जब कोई भी विज़ार्ड फ़्लैग मौजूद हो (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`), तो विज़ार्ड स्वतः चलता है।

### `onboard`

Gateway, वर्कस्पेस और Skills सेट करने के लिए इंटरैक्टिव विज़ार्ड।

विकल्प:

- `--workspace <dir>`
- `--reset` (विज़ार्ड से पहले कॉन्फ़िग + क्रेडेंशियल + सत्र + वर्कस्पेस रीसेट करें)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual, advanced का उपनाम है)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (नॉन-इंटरैक्टिव; `--auth-choice token` के साथ उपयोग)
- `--token <token>` (नॉन-इंटरैक्टिव; `--auth-choice token` के साथ उपयोग)
- `--token-profile-id <id>` (नॉन-इंटरैक्टिव; डिफ़ॉल्ट: `<provider>:manual`)
- `--token-expires-in <duration>` (नॉन-इंटरैक्टिव; जैसे `365d`, `12h`)
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
- `--no-install-daemon` (उपनाम: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm अनुशंसित; Gateway रनटाइम के लिए bun अनुशंसित नहीं)
- `--json`

### `configure`

इंटरैक्टिव कॉन्फ़िगरेशन विज़ार्ड (मॉडल, चैनल, Skills, Gateway)।

### `config`

Non-interactive config helpers (get/set/unset). Running `openclaw config` with no
subcommand launches the wizard.

उप-कमांड:

- `config get <path>`: कॉन्फ़िग मान प्रिंट करें (डॉट/ब्रैकेट पथ)।
- `config set <path> <value>`: मान सेट करें (JSON5 या रॉ स्ट्रिंग)।
- `config unset <path>`: मान हटाएँ।

### `doctor`

हेल्थ चेक + त्वरित सुधार (कॉन्फ़िग + Gateway + लेगेसी सेवाएँ)।

विकल्प:

- `--no-workspace-suggestions`: वर्कस्पेस मेमोरी संकेत अक्षम करें।
- `--yes`: बिना प्रॉम्प्ट के डिफ़ॉल्ट स्वीकार करें (हेडलैस)।
- `--non-interactive`: प्रॉम्प्ट छोड़ें; केवल सुरक्षित माइग्रेशन लागू करें।
- `--deep`: अतिरिक्त gateway इंस्टॉल के लिए सिस्टम सेवाएँ स्कैन करें।

## चैनल हेल्पर

### `channels`

चैट चैनल अकाउंट प्रबंधित करें (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (प्लगइन)/Signal/iMessage/MS Teams)।

उप-कमांड:

- `channels list`: कॉन्फ़िगर किए गए चैनल और ऑथ प्रोफ़ाइल दिखाएँ।
- `channels status`: gateway पहुँचयोग्यता और चैनल हेल्थ जाँचें (`--probe` अतिरिक्त जाँच चलाता है; gateway हेल्थ प्रोब के लिए `openclaw health` या `openclaw status --deep` का उपयोग करें)।
- सुझाव: `channels status` सामान्य मिसकॉन्फ़िगरेशन का पता लगा पाने पर सुझाए गए सुधारों के साथ चेतावनियाँ प्रिंट करता है (फिर आपको `openclaw doctor` की ओर निर्देशित करता है)।
- `channels logs`: gateway लॉग फ़ाइल से हालिया चैनल लॉग दिखाएँ।
- `channels add`: जब कोई फ़्लैग न दिया जाए तो विज़ार्ड-शैली सेटअप; फ़्लैग नॉन-इंटरैक्टिव मोड पर स्विच करते हैं।
- `channels remove`: डिफ़ॉल्ट रूप से अक्षम; बिना प्रॉम्प्ट के कॉन्फ़िग एंट्री हटाने के लिए `--delete` पास करें।
- `channels login`: इंटरैक्टिव चैनल लॉगिन (केवल WhatsApp Web)।
- `channels logout`: चैनल सत्र से लॉग आउट करें (यदि समर्थित हो)।

सामान्य विकल्प:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: चैनल अकाउंट आईडी (डिफ़ॉल्ट `default`)
- `--name <label>`: अकाउंट के लिए डिस्प्ले नाम

`channels login` विकल्प:

- `--channel <channel>` (डिफ़ॉल्ट `whatsapp`; `whatsapp`/`web` समर्थित)
- `--account <id>`
- `--verbose`

`channels logout` विकल्प:

- `--channel <channel>` (डिफ़ॉल्ट `whatsapp`)
- `--account <id>`

`channels list` विकल्प:

- `--no-usage`: मॉडल प्रदाता उपयोग/कोटा स्नैपशॉट छोड़ें (केवल OAuth/API-समर्थित)।
- `--json`: JSON आउटपुट (जब तक `--no-usage` सेट न हो, उपयोग शामिल है)।

`channels logs` विकल्प:

- `--channel <name|all>` (डिफ़ॉल्ट `all`)
- `--lines <n>` (डिफ़ॉल्ट `200`)
- `--json`

अधिक विवरण: [/concepts/oauth](/concepts/oauth)

उदाहरण:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

उपलब्ध Skills और तैयारी संबंधी जानकारी सूचीबद्ध व निरीक्षण करें।

उप-कमांड:

- `skills list`: Skills सूचीबद्ध करें (जब कोई उप-कमांड न हो तो डिफ़ॉल्ट)।
- `skills info <name>`: किसी एक Skill का विवरण दिखाएँ।
- `skills check`: तैयार बनाम अनुपस्थित आवश्यकताओं का सारांश।

विकल्प:

- `--eligible`: केवल तैयार Skills दिखाएँ।
- `--json`: JSON आउटपुट (बिना स्टाइलिंग)।
- `-v`, `--verbose`: अनुपस्थित आवश्यकताओं का विवरण शामिल करें।

सुझाव: Skills खोजने, इंस्टॉल करने और सिंक करने के लिए `npx clawhub` का उपयोग करें।

### `pairing`

चैनलों के पार DM पेयरिंग अनुरोधों को अनुमोदित करें।

उप-कमांड:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub hook setup + runner. See [/automation/gmail-pubsub](/automation/gmail-pubsub).

उप-कमांड:

- `webhooks gmail setup` (requires `--account <email>`; supports `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (उसी फ़्लैग के लिए रनटाइम ओवरराइड)

### `dns setup`

Wide-area discovery DNS helper (CoreDNS + Tailscale). See [/gateway/discovery](/gateway/discovery).

विकल्प:

- `--apply`: CoreDNS कॉन्फ़िग इंस्टॉल/अपडेट करें (sudo आवश्यक; केवल macOS)।

## मैसेजिंग + एजेंट

### `message`

एकीकृत आउटबाउंड मैसेजिंग + चैनल क्रियाएँ।

देखें: [/cli/message](/cli/message)

उप-कमांड:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

उदाहरण:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Gateway के माध्यम से (या एम्बेडेड `--local`) एक एजेंट टर्न चलाएँ।

आवश्यक:

- `--message <text>`

विकल्प:

- `--to <dest>` (सत्र कुंजी और वैकल्पिक डिलीवरी के लिए)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (केवल GPT-5.2 + Codex मॉडल)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

आइसोलेटेड एजेंट प्रबंधित करें (वर्कस्पेस + ऑथ + रूटिंग)।

#### `agents list`

कॉन्फ़िगर किए गए एजेंट सूचीबद्ध करें।

विकल्प:

- `--json`
- `--bindings`

#### `agents add [name]`

Add a new isolated agent. Runs the guided wizard unless flags (or `--non-interactive`) are passed; `--workspace` is required in non-interactive mode.

विकल्प:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (दोहराने योग्य)
- `--non-interactive`
- `--json`

Binding specs use `channel[:accountId]`. When `accountId` is omitted for WhatsApp, the default account id is used.

#### `agents delete <id>`

एजेंट हटाएँ और उसका वर्कस्पेस + स्थिति प्रून करें।

विकल्प:

- `--force`
- `--json`

### `acp`

IDE को Gateway से जोड़ने वाला ACP ब्रिज चलाएँ।

पूर्ण विकल्प और उदाहरणों के लिए [`acp`](/cli/acp) देखें।

### `status`

लिंक्ड सत्र हेल्थ और हालिया प्राप्तकर्ताओं को दिखाएँ।

विकल्प:

- `--json`
- `--all` (पूर्ण निदान; केवल-पढ़ने योग्य, पेस्ट करने योग्य)
- `--deep` (चैनलों की प्रोब)
- `--usage` (मॉडल प्रदाता उपयोग/कोटा दिखाएँ)
- `--timeout <ms>`
- `--verbose`
- `--debug` (उपनाम: `--verbose`)

नोट्स:

- अवलोकन में उपलब्ध होने पर Gateway + नोड होस्ट सेवा स्थिति शामिल होती है।

### उपयोग ट्रैकिंग

OAuth/API क्रेडेंशियल उपलब्ध होने पर OpenClaw प्रदाता उपयोग/कोटा प्रदर्शित कर सकता है।

सरफेस:

- `/status` (उपलब्ध होने पर संक्षिप्त प्रदाता उपयोग पंक्ति जोड़ता है)
- `openclaw status --usage` (पूर्ण प्रदाता ब्रेकडाउन प्रिंट करता है)
- macOS मेनू बार (Context के अंतर्गत Usage अनुभाग)

नोट्स:

- डेटा सीधे प्रदाता उपयोग एंडपॉइंट से आता है (कोई अनुमान नहीं)।
- प्रदाता: Anthropic, GitHub Copilot, OpenAI Codex OAuth, तथा Gemini CLI/Antigravity जब वे प्रदाता प्लगइन सक्षम हों।
- यदि मेल खाते क्रेडेंशियल मौजूद न हों, तो उपयोग छिपा रहता है।
- विवरण: [Usage tracking](/concepts/usage-tracking) देखें।

### `health`

चल रहे Gateway से हेल्थ प्राप्त करें।

विकल्प:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

संग्रहीत बातचीत सत्र सूचीबद्ध करें।

विकल्प:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## रीसेट / अनइंस्टॉल

### `reset`

स्थानीय कॉन्फ़िग/स्थिति रीसेट करें (CLI इंस्टॉल रहता है)।

विकल्प:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

नोट्स:

- `--non-interactive` के लिए `--scope` और `--yes` आवश्यक हैं।

### `uninstall`

gateway सेवा + स्थानीय डेटा अनइंस्टॉल करें (CLI रहता है)।

विकल्प:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

नोट्स:

- `--non-interactive` के लिए `--yes` और स्पष्ट स्कोप (या `--all`) आवश्यक हैं।

## Gateway

### `gateway`

वेब-सॉकेट Gateway चलाएँ।

विकल्प:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (डेव कॉन्फ़िग + क्रेडेंशियल + सत्र + वर्कस्पेस रीसेट करें)
- `--force` (पोर्ट पर मौजूदा लिसनर को समाप्त करें)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (उपनाम: `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gateway सेवा प्रबंधित करें (launchd/systemd/schtasks)।

उप-कमांड:

- `gateway status` (डिफ़ॉल्ट रूप से Gateway RPC की प्रोब करता है)
- `gateway install` (सेवा इंस्टॉल)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

नोट्स:

- `gateway status` सेवा के रेज़ॉल्व्ड पोर्ट/कॉन्फ़िग का उपयोग करके डिफ़ॉल्ट रूप से Gateway RPC की प्रोब करता है (ओवरराइड के लिए `--url/--token/--password` का उपयोग करें)।
- `gateway status` स्क्रिप्टिंग के लिए `--no-probe`, `--deep`, और `--json` का समर्थन करता है।
- `gateway status` also surfaces legacy or extra gateway services when it can detect them (`--deep` adds system-level scans). Profile-named OpenClaw services are treated as first-class and aren't flagged as "extra".
- `gateway status` यह प्रिंट करता है कि CLI कौन-सा कॉन्फ़िग पथ उपयोग करता है बनाम सेवा संभवतः कौन-सा कॉन्फ़िग उपयोग करती है (सेवा env), साथ ही रेज़ॉल्व्ड प्रोब लक्ष्य URL।
- `gateway install|uninstall|start|stop|restart` स्क्रिप्टिंग के लिए `--json` का समर्थन करता है (डिफ़ॉल्ट आउटपुट मानव-पठनीय रहता है)।
- `gateway install` डिफ़ॉल्ट रूप से Node रनटाइम का उपयोग करता है; bun **अनुशंसित नहीं** है (WhatsApp/Telegram बग)।
- `gateway install` विकल्प: `--port`, `--runtime`, `--token`, `--force`, `--json`।

### `logs`

RPC के माध्यम से Gateway फ़ाइल लॉग टेल करें।

नोट्स:

- TTY सत्र रंगीन, संरचित दृश्य रेंडर करते हैं; नॉन-TTY में साधारण पाठ पर वापस जाते हैं।
- `--json` लाइन-डिलिमिटेड JSON उत्सर्जित करता है (प्रति पंक्ति एक लॉग इवेंट)।

उदाहरण:

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

उप-कमांड:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

सामान्य RPCs:

- `config.apply` (मान्य करें + कॉन्फ़िग लिखें + पुनः आरंभ + वेक)
- `config.patch` (आंशिक अपडेट मर्ज करें + पुनः आरंभ + वेक)
- `update.run` (अपडेट चलाएँ + पुनः आरंभ + वेक)

सुझाव: `config.set`/`config.apply`/`config.patch` को सीधे कॉल करते समय, यदि कॉन्फ़िग पहले से मौजूद हो तो
`config.get` से `baseHash` पास करें।

## मॉडल

फ़ॉलबैक व्यवहार और स्कैनिंग रणनीति के लिए [/concepts/models](/concepts/models) देखें।

पसंदीदा Anthropic ऑथ (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (रूट)

`openclaw models`, `models status` का उपनाम है।

रूट विकल्प:

- `--status-json` (उपनाम: `models status --json`)
- `--status-plain` (उपनाम: `models status --plain`)

### `models list`

विकल्प:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

विकल्प:

- `--json`
- `--plain`
- `--check` (एग्ज़िट 1=समाप्त/अनुपस्थित, 2=समाप्त होने वाला)
- `--probe` (कॉन्फ़िगर किए गए ऑथ प्रोफ़ाइल का लाइव प्रोब)
- `--probe-provider <name>`
- `--probe-profile <id>` (दोहराव या कॉमा-सेपरेटेड)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Always includes the auth overview and OAuth expiry status for profiles in the auth store.
`--probe` runs live requests (may consume tokens and trigger rate limits).

### `models set <model>`

`agents.defaults.model.primary` सेट करें।

### `models set-image <model>`

`agents.defaults.imageModel.primary` सेट करें।

### `models aliases list|add|remove`

विकल्प:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

विकल्प:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

विकल्प:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

विकल्प:

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

विकल्प:

- `add`: इंटरैक्टिव ऑथ हेल्पर
- `setup-token`: `--provider <name>` (डिफ़ॉल्ट `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

विकल्प:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## सिस्टम

### `system event`

एक सिस्टम इवेंट कतारबद्ध करें और वैकल्पिक रूप से हार्टबीट ट्रिगर करें (Gateway RPC)।

आवश्यक:

- `--text <text>`

विकल्प:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

हार्टबीट नियंत्रण (Gateway RPC)।

विकल्प:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

सिस्टम उपस्थिति प्रविष्टियाँ सूचीबद्ध करें (Gateway RPC)।

विकल्प:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## क्रॉन

Manage scheduled jobs (Gateway RPC). See [/automation/cron-jobs](/automation/cron-jobs).

उप-कमांड:

- `cron status [--json]`
- `cron list [--all] [--json]` (डिफ़ॉल्ट रूप से टेबल आउटपुट; रॉ के लिए `--json` का उपयोग करें)
- `cron add` (उपनाम: `create`; `--name` और ठीक एक `--at` | `--every` | `--cron` आवश्यक, तथा ठीक एक पेलोड `--system-event` | `--message`)
- `cron edit <id>` (फ़ील्ड पैच करें)
- `cron rm <id>` (उपनाम: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

सभी `cron` कमांड `--url`, `--token`, `--timeout`, `--expect-final` स्वीकार करते हैं।

## नोड होस्ट

`node` runs a **headless node host** or manages it as a background service. See
[`openclaw node`](/cli/node).

उप-कमांड:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## नोड्स

`nodes` talks to the Gateway and targets paired nodes. See [/nodes](/nodes).

सामान्य विकल्प:

- `--url`, `--token`, `--timeout`, `--json`

उप-कमांड:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac नोड या हेडलैस नोड होस्ट)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (केवल mac)

कैमरा:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

कैनवास + स्क्रीन:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

स्थान:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## ब्राउज़र

Browser control CLI (dedicated Chrome/Brave/Edge/Chromium). See [`openclaw browser`](/cli/browser) and the [Browser tool](/tools/browser).

सामान्य विकल्प:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

प्रबंधन:

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

निरीक्षण:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

क्रियाएँ:

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

## डॉक्स खोज

### `docs [query...]`

लाइव डॉक्स इंडेक्स खोजें।

## TUI

### `tui`

Gateway से जुड़े टर्मिनल UI को खोलें।

विकल्प:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (डिफ़ॉल्ट `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
