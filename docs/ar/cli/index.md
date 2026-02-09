---
summary: "مرجع OpenClaw CLI لأوامر `openclaw` والأوامر الفرعية والخيارات"
read_when:
  - إضافة أو تعديل أوامر CLI أو الخيارات
  - توثيق أسطح أوامر جديدة
title: "مرجع CLI"
---

# مرجع CLI

تصف هذه الصفحة سلوك CLI الحالي. إذا تغيّرت الأوامر، حدّث هذا المستند.

## صفحات الأوامر

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
- [`plugins`](/cli/plugins) (أوامر الإضافات)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (إضافة؛ إذا كانت مثبّتة)

## الأعلام العالمية

- `--dev`: عزل الحالة ضمن `~/.openclaw-dev` وتحويل المنافذ الافتراضية.
- `--profile <name>`: عزل الحالة ضمن `~/.openclaw-<name>`.
- `--no-color`: تعطيل ألوان ANSI.
- `--update`: اختصار لـ `openclaw update` (تثبيتات المصدر فقط).
- `-V`, `--version`, `-v`: طباعة الإصدار والخروج.

## تنسيق الإخراج

- تُعرض ألوان ANSI ومؤشرات التقدّم فقط في جلسات TTY.
- تُعرض روابط OSC-8 كروابط قابلة للنقر في الطرفيات المدعومة؛ وإلا نعود إلى عناوين URL نصية.
- `--json` (و`--plain` حيثما كان مدعومًا) يعطّل التنسيق لإخراج نظيف.
- `--no-color` يعطّل تنسيق ANSI؛ كما يتم احترام `NO_COLOR=1`.
- تُظهر الأوامر طويلة التشغيل مؤشر تقدّم (OSC 9;4 عند الدعم).

## لوحة الألوان

يستخدم OpenClaw لوحة «lobster» لإخراج CLI.

- `accent` (#FF5A2D): العناوين، التسميات، التمييز الأساسي.
- `accentBright` (#FF7A3D): أسماء الأوامر، إبراز.
- `accentDim` (#D14A22): نص تمييز ثانوي.
- `info` (#FF8A5B): قيم معلوماتية.
- `success` (#2FBF71): حالات النجاح.
- `warn` (#FFB020): التحذيرات، البدائل، لفت الانتباه.
- `error` (#E23D2D): الأخطاء، الإخفاقات.
- `muted` (#8B7F77): خفض التمييز، بيانات وصفية.

مصدر الحقيقة للوحة الألوان: `src/terminal/palette.ts` (المعروف أيضًا باسم «lobster seam»).

## شجرة الأوامر

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

ملاحظة: يمكن للإضافات إضافة أوامر عليا إضافية (على سبيل المثال `openclaw voicecall`).

## الأمان

- `openclaw security audit` — تدقيق التهيئة + الحالة المحلية لاكتشاف أخطاء أمان شائعة.
- `openclaw security audit --deep` — فحص مباشر بأفضل جهد لـ Gateway.
- `openclaw security audit --fix` — تشديد الإعدادات الافتراضية الآمنة وتغيير أذونات chmod للحالة/التهيئة.

## الإضافات

إدارة الامتدادات وتهيئتها:

- `openclaw plugins list` — اكتشاف الإضافات (استخدم `--json` لإخراج الآلة).
- `openclaw plugins info <id>` — عرض تفاصيل إضافة.
- `openclaw plugins install <path|.tgz|npm-spec>` — تثبيت إضافة (أو إضافة مسار إضافة إلى `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — تبديل `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — الإبلاغ عن أخطاء تحميل الإضافات.

تتطلّب معظم تغييرات الإضافات إعادة تشغيل Gateway. راجع [/plugin](/tools/plugin).

## الذاكرة

بحث متجهي عبر `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — عرض إحصاءات الفهرس.
- `openclaw memory index` — إعادة فهرسة ملفات الذاكرة.
- `openclaw memory search "<query>"` — بحث دلالي عبر الذاكرة.

## أوامر خط الدردشة

تدعم رسائل الدردشة أوامر `/...` (نصية وأصلية). راجع [/tools/slash-commands](/tools/slash-commands).

أبرز النقاط:

- `/status` للتشخيص السريع.
- `/config` لتغييرات التهيئة المُستدامة.
- `/debug` لتجاوزات التهيئة أثناء التشغيل فقط (في الذاكرة، لا على القرص؛ يتطلّب `commands.debug: true`).

## الإعداد + التهيئة الأولية

### `setup`

تهيئة التهيئة + مساحة العمل.

الخيارات:

- `--workspace <dir>`: مسار مساحة عمل الوكيل (الافتراضي `~/.openclaw/workspace`).
- `--wizard`: تشغيل معالج الإعداد.
- `--non-interactive`: تشغيل المعالج دون مطالبات.
- `--mode <local|remote>`: وضع المعالج.
- `--remote-url <url>`: عنوان URL لـ Gateway بعيد.
- `--remote-token <token>`: رمز Gateway بعيد.

يعمل المعالج تلقائيًا عند وجود أي من رايات المعالج (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

معالج تفاعلي لإعداد Gateway ومساحة العمل والـ Skills.

الخيارات:

- `--workspace <dir>`
- `--reset` (إعادة ضبط التهيئة + بيانات الاعتماد + الجلسات + مساحة العمل قبل المعالج)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual اسم بديل لـ advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (غير تفاعلي؛ يُستخدم مع `--auth-choice token`)
- `--token <token>` (غير تفاعلي؛ يُستخدم مع `--auth-choice token`)
- `--token-profile-id <id>` (غير تفاعلي؛ الافتراضي: `<provider>:manual`)
- `--token-expires-in <duration>` (غير تفاعلي؛ مثل `365d`, `12h`)
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
- `--no-install-daemon` (اسم بديل: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (يوصى بـ pnpm؛ bun غير موصى به لوقت تشغيل Gateway)
- `--json`

### `configure`

معالج تهيئة تفاعلي (النماذج، القنوات، Skills، Gateway).

### `config`

مساعدات تهيئة غير تفاعلية (get/set/unset). تشغيل `openclaw config` دون
أمر فرعي يطلق المعالج.

الأوامر الفرعية:

- `config get <path>`: طباعة قيمة تهيئة (مسار بنقطة/أقواس).
- `config set <path> <value>`: تعيين قيمة (JSON5 أو سلسلة خام).
- `config unset <path>`: إزالة قيمة.

### `doctor`

فحوصات الصحة + إصلاحات سريعة (التهيئة + Gateway + الخدمات القديمة).

الخيارات:

- `--no-workspace-suggestions`: تعطيل تلميحات ذاكرة مساحة العمل.
- `--yes`: قبول الافتراضيات دون مطالبة (بدون واجهة).
- `--non-interactive`: تخطي المطالبات؛ تطبيق ترحيلات آمنة فقط.
- `--deep`: فحص خدمات النظام بحثًا عن تثبيتات Gateway إضافية.

## مساعدات القنوات

### `channels`

إدارة حسابات قنوات الدردشة (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (إضافة)/Signal/iMessage/MS Teams).

الأوامر الفرعية:

- `channels list`: عرض القنوات المهيّأة وملفات المصادقة.
- `channels status`: التحقق من قابلية الوصول إلى Gateway وصحة القنوات (`--probe` يجري فحوصات إضافية؛ استخدم `openclaw health` أو `openclaw status --deep` لفحوصات صحة Gateway).
- تلميح: `channels status` يطبع تحذيرات مع إصلاحات مقترحة عند اكتشاف سوء تهيئة شائع (ثم يوجّهك إلى `openclaw doctor`).
- `channels logs`: عرض سجلات القنوات الحديثة من ملف سجل Gateway.
- `channels add`: إعداد بأسلوب المعالج عند عدم تمرير رايات؛ تمرير الرايات يحوّل إلى وضع غير تفاعلي.
- `channels remove`: معطّل افتراضيًا؛ مرّر `--delete` لإزالة إدخالات التهيئة دون مطالبات.
- `channels login`: تسجيل دخول تفاعلي للقناة (WhatsApp Web فقط).
- `channels logout`: تسجيل الخروج من جلسة قناة (إن كان مدعومًا).

الخيارات الشائعة:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: معرّف حساب القناة (الافتراضي `default`)
- `--name <label>`: اسم العرض للحساب

خيارات `channels login`:

- `--channel <channel>` (الافتراضي `whatsapp`; يدعم `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

خيارات `channels logout`:

- `--channel <channel>` (الافتراضي `whatsapp`)
- `--account <id>`

خيارات `channels list`:

- `--no-usage`: تخطي لقطات استخدام/حصة موفّر النموذج (OAuth/API فقط).
- `--json`: إخراج JSON (يتضمن الاستخدام ما لم يتم تعيين `--no-usage`).

خيارات `channels logs`:

- `--channel <name|all>` (الافتراضي `all`)
- `--lines <n>` (الافتراضي `200`)
- `--json`

تفاصيل أكثر: [/concepts/oauth](/concepts/oauth)

أمثلة:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

سرد وفحص Skills المتاحة إضافةً إلى معلومات الجاهزية.

الأوامر الفرعية:

- `skills list`: سرد Skills (الافتراضي عند عدم وجود أمر فرعي).
- `skills info <name>`: عرض تفاصيل Skill واحدة.
- `skills check`: ملخّص الجاهز مقابل المتطلبات المفقودة.

الخيارات:

- `--eligible`: عرض Skills الجاهزة فقط.
- `--json`: إخراج JSON (دون تنسيق).
- `-v`, `--verbose`: تضمين تفاصيل المتطلبات المفقودة.

تلميح: استخدم `npx clawhub` للبحث عن Skills وتثبيتها ومزامنتها.

### `pairing`

الموافقة على طلبات إقران الرسائل الخاصة عبر القنوات.

الأوامر الفرعية:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

إعداد خطاف Gmail Pub/Sub + المشغّل. راجع [/automation/gmail-pubsub](/automation/gmail-pubsub).

الأوامر الفرعية:

- `webhooks gmail setup` (يتطلّب `--account <email>`; يدعم `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (تجاوزات وقت التشغيل لنفس الرايات)

### `dns setup`

مساعد DNS للاكتشاف واسع النطاق (CoreDNS + Tailscale). راجع [/gateway/discovery](/gateway/discovery).

الخيارات:

- `--apply`: تثبيت/تحديث تهيئة CoreDNS (يتطلّب sudo؛ macOS فقط).

## المراسلة + الوكيل

### `message`

مراسلة صادرة موحّدة + إجراءات القنوات.

راجع: [/cli/message](/cli/message)

الأوامر الفرعية:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

أمثلة:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

تشغيل دورة وكيل واحدة عبر Gateway (أو `--local` المضمّن).

مطلوب:

- `--message <text>`

الخيارات:

- `--to <dest>` (لمفتاح الجلسة وتسليم اختياري)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (نماذج GPT-5.2 + Codex فقط)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

إدارة الوكلاء المعزولين (مساحات العمل + المصادقة + التوجيه).

#### `agents list`

قائمة الوكلاء الذين تم تكوينهم.

الخيارات:

- `--json`
- `--bindings`

#### `agents add [name]`

إضافة وكيل معزول جديد. يشغّل المعالج الإرشادي ما لم يتم تمرير رايات (أو `--non-interactive`)؛ `--workspace` مطلوب في الوضع غير التفاعلي.

الخيارات:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (قابل للتكرار)
- `--non-interactive`
- `--json`

تستخدم مواصفات الربط `channel[:accountId]`. عند حذف `accountId` لـ WhatsApp، يتم استخدام معرّف الحساب الافتراضي.

#### `agents delete <id>`

حذف وكيل وتقليص مساحة عمله + حالته.

الخيارات:

- `--force`
- `--json`

### `acp`

تشغيل جسر ACP الذي يربط IDEs بـ Gateway.

راجع [`acp`](/cli/acp) للاطلاع على الخيارات والأمثلة الكاملة.

### `status`

عرض صحة الجلسات المرتبطة والمستلمين الحديثين.

الخيارات:

- `--json`
- `--all` (تشخيص كامل؛ للقراءة فقط، قابل للصق)
- `--deep` (فحص القنوات)
- `--usage` (عرض استخدام/حصة موفّر النموذج)
- `--timeout <ms>`
- `--verbose`
- `--debug` (اسم بديل لـ `--verbose`)

ملاحظات:

- تتضمن النظرة العامة حالة خدمة Gateway + مضيف العُقدة عند توفرها.

### تتبّع الاستخدام

يمكن لـ OpenClaw إظهار استخدام/حصة الموفّر عند توفر بيانات اعتماد OAuth/API.

الأسطح:

- `/status` (يضيف سطر استخدام قصير للموفّر عند توفره)
- `openclaw status --usage` (يطبع تفصيلاً كاملاً حسب الموفّر)
- شريط قائمة macOS (قسم Usage ضمن Context)

ملاحظات:

- تأتي البيانات مباشرةً من نقاط نهاية استخدام الموفّر (دون تقديرات).
- الموفّرون: Anthropic، GitHub Copilot، OpenAI Codex OAuth، بالإضافة إلى Gemini CLI/Antigravity عند تمكين إضافات تلك الموفّرين.
- إذا لم توجد بيانات اعتماد مطابقة، يتم إخفاء الاستخدام.
- التفاصيل: راجع [Usage tracking](/concepts/usage-tracking).

### `health`

جلب الصحة من Gateway قيد التشغيل.

الخيارات:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

سرد جلسات المحادثة المخزّنة.

الخيارات:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## إعادة الضبط / إلغاء التثبيت

### `reset`

إعادة ضبط التهيئة/الحالة المحلية (مع الإبقاء على تثبيت CLI).

الخيارات:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

ملاحظات:

- `--non-interactive` يتطلّب `--scope` و`--yes`.

### `uninstall`

إلغاء تثبيت خدمة Gateway + البيانات المحلية (يبقى CLI).

الخيارات:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

ملاحظات:

- `--non-interactive` يتطلّب `--yes` ونطاقات صريحة (أو `--all`).

## Gateway

### `gateway`

تشغيل Gateway عبر WebSocket.

الخيارات:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (إعادة ضبط تهيئة التطوير + بيانات الاعتماد + الجلسات + مساحة العمل)
- `--force` (قتل المستمع الموجود على المنفذ)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (اسم بديل لـ `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

إدارة خدمة Gateway (launchd/systemd/schtasks).

الأوامر الفرعية:

- `gateway status` (يفحص Gateway RPC افتراضيًا)
- `gateway install` (تثبيت الخدمة)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

ملاحظات:

- `gateway status` يفحص Gateway RPC افتراضيًا باستخدام المنفذ/التهيئة المُحلّلة للخدمة (يمكن التجاوز عبر `--url/--token/--password`).
- `gateway status` يدعم `--no-probe` و`--deep` و`--json` للبرمجة النصية.
- `gateway status` يعرض أيضًا خدمات Gateway القديمة أو الإضافية عند اكتشافها (`--deep` يضيف فحوصات على مستوى النظام). تُعامل خدمات OpenClaw المسماة بالملف الشخصي كخدمات من الدرجة الأولى ولا تُعلّم كـ «إضافية».
- `gateway status` يطبع مسار التهيئة الذي يستخدمه CLI مقابل التهيئة التي يُحتمل أن تستخدمها الخدمة (بيئة الخدمة)، إضافةً إلى عنوان URL لهدف الفحص المُحلّل.
- `gateway install|uninstall|start|stop|restart` يدعم `--json` للبرمجة النصية (يبقى الإخراج الافتراضي مناسبًا للبشر).
- `gateway install` يستخدم Node افتراضيًا؛ bun **غير موصى به** (مشكلات WhatsApp/Telegram).
- خيارات `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

تتبّع سجلات ملفات Gateway عبر RPC.

ملاحظات:

- تُظهر جلسات TTY عرضًا ملوّنًا ومنظّمًا؛ وتعود الجلسات غير TTY إلى نص عادي.
- `--json` يُخرج JSON محدّد الأسطر (حدث سجل واحد لكل سطر).

أمثلة:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

مساعدات Gateway CLI (استخدم `--url`, `--token`, `--password`, `--timeout`, `--expect-final` للأوامر الفرعية RPC).
عند تمرير `--url`، لا يطبّق CLI التهيئة أو بيانات اعتماد البيئة تلقائيًا.
ضمّن `--token` أو `--password` صراحةً. غياب بيانات اعتماد صريحة يُعد خطأً.

الأوامر الفرعية:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

الرايات العامة

- `config.apply` (تحقق + كتابة تهيئة + إعادة تشغيل + إيقاظ)
- `config.patch` (دمج تحديث جزئي + إعادة تشغيل + إيقاظ)
- `update.run` (تشغيل تحديث + إعادة تشغيل + إيقاظ)

تلميح: عند استدعاء `config.set`/`config.apply`/`config.patch` مباشرةً، مرّر `baseHash` من
`config.get` إذا كانت هناك تهيئة موجودة بالفعل.

## النماذج

راجع [/concepts/models](/concepts/models) لسلوكيات التراجع واستراتيجية الفحص.

مصادقة Anthropic المفضّلة (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (الجذر)

`openclaw models` اسم بديل لـ `models status`.

خيارات الجذر:

- `--status-json` (اسم بديل لـ `models status --json`)
- `--status-plain` (اسم بديل لـ `models status --plain`)

### `models list`

الخيارات:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

الخيارات:

- `--json`
- `--plain`
- `--check` (الخروج 1=منتهي/مفقود، 2=قارب على الانتهاء)
- `--probe` (فحص مباشر لملفات المصادقة المهيّأة)
- `--probe-provider <name>`
- `--probe-profile <id>` (تكرار أو مفصول بفواصل)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

يتضمن دائمًا نظرة عامة على المصادقة وحالة انتهاء OAuth للملفات في مخزن المصادقة.
`--probe` يشغّل طلبات مباشرة (قد يستهلك رموزًا ويؤدي إلى حدود المعدّل).

### `models set <model>`

تعيين `agents.defaults.model.primary`.

### `models set-image <model>`

تعيين `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

الخيارات:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

الخيارات:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

الخيارات:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

الخيارات:

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

الخيارات:

- `add`: مساعد مصادقة تفاعلي
- `setup-token`: `--provider <name>` (الافتراضي `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

الخيارات:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## النظام

### `system event`

إدراج حدث نظامي واختياريًا تشغيل نبضة قلب (Gateway RPC).

مطلوب:

- `--text <text>`

الخيارات:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

ضوابط نبضة القلب (Gateway RPC).

الخيارات:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

سرد إدخالات حضور النظام (Gateway RPC).

الخيارات:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

إدارة المهام المجدولة (Gateway RPC). راجع [/automation/cron-jobs](/automation/cron-jobs).

الأوامر الفرعية:

- `cron status [--json]`
- `cron list [--all] [--json]` (إخراج جدولي افتراضيًا؛ استخدم `--json` للخام)
- `cron add` (اسم بديل: `create`; يتطلّب `--name` وبالضبط واحدًا من `--at` | `--every` | `--cron`، وبالضبط حمولة واحدة من `--system-event` | `--message`)
- `cron edit <id>` (تصحيح الحقول)
- `cron rm <id>` (أسماء بديلة: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

تقبل جميع أوامر `cron` الرايات `--url`, `--token`, `--timeout`, `--expect-final`.

## مضيف العُقدة

يشغّل `node` **مضيف عُقدة بدون واجهة** أو يديره كخدمة في الخلفية. راجع
[`openclaw node`](/cli/node).

الأوامر الفرعية:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

يتواصل `nodes` مع Gateway ويستهدف العُقد المقترنة. راجع [/nodes](/nodes).

الخيارات الشائعة:

- `--url`, `--token`, `--timeout`, `--json`

الأوامر الفرعية:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (عُقدة mac أو مضيف عُقدة بدون واجهة)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac فقط)

الكاميرا:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

اللوحة + الشاشة:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

الموقع:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## المتصفح

CLI للتحكّم بالمتصفح (Chrome/Brave/Edge/Chromium مخصّص). راجع [`openclaw browser`](/cli/browser) و[أداة المتصفح](/tools/browser).

الخيارات الشائعة:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

الإدارة:

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

الفحص:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

الإجراءات:

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

## البحث في المستندات

### `docs [query...]`

البحث في فهرس المستندات المباشر.

## TUI

### `tui`

فتح واجهة المستخدم الطرفية المتصلة بـ Gateway.

الخيارات:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (الافتراضي `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
