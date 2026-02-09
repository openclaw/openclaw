---
summary: "เอกสารอ้างอิง OpenClaw CLI สำหรับคำสั่ง `openclaw` คำสั่งย่อย และตัวเลือก"
read_when:
  - เมื่อเพิ่มหรือแก้ไขคำสั่งหรือตัวเลือกของCLI
  - เมื่อจัดทำเอกสารพื้นผิวคำสั่งใหม่
title: "เอกสารอ้างอิงCLI"
---

# เอกสารอ้างอิงCLI

หน้านี้อธิบายพฤติกรรม CLI ปัจจุบัน หน้านี้อธิบายพฤติกรรมCLIปัจจุบัน หากคำสั่งมีการเปลี่ยนแปลง ให้ปรับปรุงเอกสารนี้

## หน้าคำสั่ง

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
- [`plugins`](/cli/plugins) (คำสั่งปลั๊กอิน)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (ปลั๊กอิน; หากติดตั้ง)

## แฟล็กส่วนกลาง

- `--dev`: แยกสถานะภายใต้ `~/.openclaw-dev` และเลื่อนพอร์ตค่าเริ่มต้น
- `--profile <name>`: แยกสถานะภายใต้ `~/.openclaw-<name>`
- `--no-color`: ปิดการใช้สีANSI
- `--update`: คำย่อสำหรับ `openclaw update` (เฉพาะการติดตั้งจากซอร์ส)
- `-V`, `--version`, `-v`: พิมพ์เวอร์ชันและออก

## การจัดรูปแบบเอาต์พุต

- สีANSIและตัวบ่งชี้ความคืบหน้าจะแสดงเฉพาะในเซสชันTTY
- ไฮเปอร์ลิงก์OSC-8 จะแสดงเป็นลิงก์ที่คลิกได้ในเทอร์มินัลที่รองรับ มิฉะนั้นจะถอยกลับเป็นURLธรรมดา
- `--json` (และ `--plain` เมื่อรองรับ) ปิดการจัดรูปแบบเพื่อเอาต์พุตที่สะอาด
- `--no-color` ปิดการจัดรูปแบบANSI; `NO_COLOR=1` ก็ถูกเคารพเช่นกัน
- คำสั่งที่ใช้เวลานานจะแสดงตัวบ่งชี้ความคืบหน้า (OSC 9;4 เมื่อรองรับ)

## พาเล็ตสี

OpenClaw ใช้พาเล็ตสี lobster สำหรับเอาต์พุตCLI

- `accent` (#FF5A2D): หัวข้อ ป้ายกำกับ ไฮไลต์หลัก
- `accentBright` (#FF7A3D): ชื่อคำสั่ง การเน้น
- `accentDim` (#D14A22): ข้อความไฮไลต์รอง
- `info` (#FF8A5B): ค่าข้อมูล
- `success` (#2FBF71): สถานะสำเร็จ
- `warn` (#FFB020): คำเตือน ทางเลือก การดึงความสนใจ
- `error` (#E23D2D): ข้อผิดพลาด ความล้มเหลว
- `muted` (#8B7F77): การลดความเด่น, เมทาดาทา

แหล่งอ้างอิงพาเล็ตหลัก: `src/terminal/palette.ts` (หรือที่เรียกว่า “lobster seam”)

## โครงสร้างคำสั่ง

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

หมายเหตุ: ปลั๊กอินสามารถเพิ่มคำสั่งระดับบนเพิ่มเติมได้ (เช่น `openclaw voicecall`)

## ความปลอดภัย

- `openclaw security audit` — ตรวจสอบคอนฟิก+สถานะภายในเครื่องเพื่อค้นหาจุดพลาดด้านความปลอดภัยที่พบบ่อย
- `openclaw security audit --deep` — โพรบGatewayแบบสดตามความพยายามที่เหมาะสม
- `openclaw security audit --fix` — กระชับค่าเริ่มต้นที่ปลอดภัยและ chmod สถานะ/คอนฟิก

## ปลั๊กอิน

จัดการส่วนขยายและคอนฟิกของปลั๊กอิน:

- `openclaw plugins list` — ค้นพบปลั๊กอิน (ใช้ `--json` สำหรับเอาต์พุตแบบเครื่องอ่านได้)
- `openclaw plugins info <id>` — แสดงรายละเอียดปลั๊กอิน
- `openclaw plugins install <path|.tgz|npm-spec>` — ติดตั้งปลั๊กอิน (หรือเพิ่มพาธปลั๊กอินไปยัง `plugins.load.paths`)
- `openclaw plugins enable <id>` / `disable <id>` — สลับ `plugins.entries.<id>.enabled`
- `openclaw plugins doctor` — รายงานข้อผิดพลาดการโหลดปลั๊กอิน

การเปลี่ยนแปลงปลั๊กอินส่วนใหญ่ต้องรีสตาร์ทGateway ดู [/plugin](/tools/plugin) ดู [/plugin](/tools/plugin).

## หน่วยความจำ

การค้นหาเวกเตอร์เหนือ `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — แสดงสถิติดัชนี
- `openclaw memory index` — จัดทำดัชนีไฟล์หน่วยความจำใหม่
- `openclaw memory search "<query>"` — ค้นหาเชิงความหมายในหน่วยความจำ

## คำสั่งสแลชในแชต

ข้อความแชตรองรับคำสั่ง `/...` (ข้อความและเนทีฟ) ดู [/tools/slash-commands](/tools/slash-commands) ดู [/tools/slash-commands](/tools/slash-commands).

ไฮไลต์:

- `/status` สำหรับการวินิจฉัยอย่างรวดเร็ว
- `/config` สำหรับการเปลี่ยนแปลงคอนฟิกแบบถาวร
- `/debug` สำหรับการแทนที่คอนฟิกเฉพาะขณะรัน (อยู่ในหน่วยความจำ ไม่เขียนดิสก์; ต้องใช้ `commands.debug: true`)

## การตั้งค่า+การเริ่มต้นใช้งาน

### `setup`

เริ่มต้นคอนฟิก+เวิร์กสเปซ

ตัวเลือก:

- `--workspace <dir>`: พาธเวิร์กสเปซเอเจนต์ (ค่าเริ่มต้น `~/.openclaw/workspace`)
- `--wizard`: เรียกใช้วิซาร์ดเริ่มต้นใช้งาน
- `--non-interactive`: เรียกใช้วิซาร์ดโดยไม่ถาม
- `--mode <local|remote>`: โหมดวิซาร์ด
- `--remote-url <url>`: URLของGatewayระยะไกล
- `--remote-token <token>`: โทเคนGatewayระยะไกล

วิซาร์ดจะรันอัตโนมัติเมื่อมีแฟล็กวิซาร์ดใดๆ (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`)

### `onboard`

วิซาร์ดแบบโต้ตอบสำหรับตั้งค่าGateway เวิร์กสเปซ และSkills

ตัวเลือก:

- `--workspace <dir>`
- `--reset` (รีเซ็ตคอนฟิก+ข้อมูลรับรอง+เซสชัน+เวิร์กสเปซก่อนวิซาร์ด)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual เป็นนามแฝงของ advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (ไม่โต้ตอบ; ใช้ร่วมกับ `--auth-choice token`)
- `--token <token>` (ไม่โต้ตอบ; ใช้ร่วมกับ `--auth-choice token`)
- `--token-profile-id <id>` (ไม่โต้ตอบ; ค่าเริ่มต้น: `<provider>:manual`)
- `--token-expires-in <duration>` (ไม่โต้ตอบ; เช่น `365d`, `12h`)
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
- `--no-install-daemon` (นามแฝง: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (แนะนำ pnpm; ไม่แนะนำ bun สำหรับรันไทม์Gateway)
- `--json`

### `configure`

วิซาร์ดการกำหนดค่าแบบโต้ตอบ (โมเดล ช่องทาง Skills Gateway)

### `config`

ตัวช่วยคอนฟิกแบบไม่โต้ตอบ (get/set/unset). ตัวช่วยคอนฟิกแบบไม่โต้ตอบ (get/set/unset) การรัน `openclaw config` โดยไม่มีคำสั่งย่อยจะเปิดวิซาร์ด

คำสั่งย่อย:

- `config get <path>`: พิมพ์ค่าคอนฟิก (พาธแบบจุด/วงเล็บ)
- `config set <path> <value>`: ตั้งค่า (JSON5 หรือสตริงดิบ)
- `config unset <path>`: ลบค่า

### `doctor`

การตรวจสุขภาพ+การแก้ไขด่วน (คอนฟิก+Gateway+บริการเดิม)

ตัวเลือก:

- `--no-workspace-suggestions`: ปิดคำแนะนำหน่วยความจำเวิร์กสเปซ
- `--yes`: ยอมรับค่าเริ่มต้นโดยไม่ถาม (โหมดหัวขาด)
- `--non-interactive`: ข้ามคำถาม; ใช้เฉพาะการย้ายที่ปลอดภัย
- `--deep`: สแกนบริการระบบเพื่อค้นหาการติดตั้งGatewayเพิ่มเติม

## ตัวช่วยช่องทาง

### `channels`

จัดการบัญชีช่องทางแชต (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (ปลั๊กอิน)/Signal/iMessage/MS Teams)

คำสั่งย่อย:

- `channels list`: แสดงช่องทางที่กำหนดค่าและโปรไฟล์การยืนยันตัวตน
- `channels status`: ตรวจสอบการเข้าถึงGatewayและสุขภาพช่องทาง (`--probe` ทำการตรวจเพิ่มเติม; ใช้ `openclaw health` หรือ `openclaw status --deep` สำหรับโพรบสุขภาพGateway)
- เคล็ดลับ: `channels status` พิมพ์คำเตือนพร้อมวิธีแก้ไขที่แนะนำเมื่อสามารถตรวจพบการกำหนดค่าที่ผิดพลาดทั่วไปได้ (แล้วชี้ไปที่ `openclaw doctor`)
- `channels logs`: แสดงล็อกช่องทางล่าสุดจากไฟล์ล็อกGateway
- `channels add`: ตั้งค่าแบบวิซาร์ดเมื่อไม่ส่งแฟล็ก; การส่งแฟล็กจะสลับเป็นโหมดไม่โต้ตอบ
- `channels remove`: ปิดใช้งานเป็นค่าเริ่มต้น; ส่ง `--delete` เพื่อลบรายการคอนฟิกโดยไม่ถาม
- `channels login`: ล็อกอินช่องทางแบบโต้ตอบ (เฉพาะ WhatsApp Web)
- `channels logout`: ออกจากระบบเซสชันช่องทาง (หากรองรับ)

ตัวเลือกทั่วไป:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: idบัญชีช่องทาง (ค่าเริ่มต้น `default`)
- `--name <label>`: ชื่อแสดงของบัญชี

ตัวเลือก `channels login`:

- `--channel <channel>` (ค่าเริ่มต้น `whatsapp`; รองรับ `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

ตัวเลือก `channels logout`:

- `--channel <channel>` (ค่าเริ่มต้น `whatsapp`)
- `--account <id>`

ตัวเลือก `channels list`:

- `--no-usage`: ข้ามสแนปช็อตการใช้งาน/โควตาของผู้ให้บริการโมเดล (เฉพาะ OAuth/API)
- `--json`: เอาต์พุตJSON (รวมการใช้งานเว้นแต่ตั้งค่า `--no-usage`)

ตัวเลือก `channels logs`:

- `--channel <name|all>` (ค่าเริ่มต้น `all`)
- `--lines <n>` (ค่าเริ่มต้น `200`)
- `--json`

รายละเอียดเพิ่มเติม: [/concepts/oauth](/concepts/oauth)

ตัวอย่าง:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

แสดงรายการและตรวจสอบSkillsที่มีพร้อมข้อมูลความพร้อมใช้งาน

คำสั่งย่อย:

- `skills list`: แสดงรายการSkills (ค่าเริ่มต้นเมื่อไม่มีคำสั่งย่อย)
- `skills info <name>`: แสดงรายละเอียดของSkillหนึ่งรายการ
- `skills check`: สรุปSkillsที่พร้อมใช้งานเทียบกับข้อกำหนดที่ขาด

ตัวเลือก:

- `--eligible`: แสดงเฉพาะSkillsที่พร้อม
- `--json`: เอาต์พุตJSON (ไม่จัดรูปแบบ)
- `-v`, `--verbose`: รวมรายละเอียดข้อกำหนดที่ขาด

เคล็ดลับ: ใช้ `npx clawhub` เพื่อค้นหา ติดตั้ง และซิงก์Skills

### `pairing`

อนุมัติคำขอจับคู่DMข้ามช่องทาง

คำสั่งย่อย:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

การตั้งค่า + ตัวรัน Gmail Pub/Sub hook. การตั้งค่า+ตัวรัน Gmail Pub/Sub hook ดู [/automation/gmail-pubsub](/automation/gmail-pubsub)

คำสั่งย่อย:

- `webhooks gmail setup` (ต้องใช้ `--account <email>`; รองรับ `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (การแทนที่รันไทม์สำหรับแฟล็กเดียวกัน)

### `dns setup`

ตัวช่วยDNSสำหรับการค้นหาในวงกว้าง (CoreDNS+Tailscale) ดู [/gateway/discovery](/gateway/discovery) ดู [/gateway/discovery](/gateway/discovery).

ตัวเลือก:

- `--apply`: ติดตั้ง/อัปเดตคอนฟิกCoreDNS (ต้องใช้ sudo; macOSเท่านั้น)

## การส่งข้อความ+เอเจนต์

### `message`

การส่งข้อความขาออกแบบรวมศูนย์+การดำเนินการช่องทาง

ดู: [/cli/message](/cli/message)

คำสั่งย่อย:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

ตัวอย่าง:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

รันหนึ่งเทิร์นของเอเจนต์ผ่านGateway (หรือ `--local` แบบฝัง)

ต้องมี:

- `--message <text>`

ตัวเลือก:

- `--to <dest>` (สำหรับคีย์เซสชันและการส่งมอบเสริม)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (เฉพาะโมเดล GPT-5.2+Codex)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

จัดการเอเจนต์แบบแยก (เวิร์กสเปซ+การยืนยันตัวตน+การกำหนดเส้นทาง)

#### `agents list`

แสดงรายการเอเจนต์ที่กำหนดค่าไว้

ตัวเลือก:

- `--json`
- `--bindings`

#### `agents add [name]`

เพิ่มเอเจนต์แบบแยกใหม่ เพิ่มเอเจนต์แบบแยกใหม่ จะรันวิซาร์ดแบบแนะนำเว้นแต่ส่งแฟล็ก (หรือ `--non-interactive`); โหมดไม่โต้ตอบต้องใช้ `--workspace`

ตัวเลือก:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (ซ้ำได้)
- `--non-interactive`
- `--json`

สเปกการผูกใช้รูปแบบ `channel[:accountId]`. สเปกการผูกใช้ `channel[:accountId]` เมื่อไม่ระบุ `accountId` สำหรับWhatsApp จะใช้ idบัญชีค่าเริ่มต้น

#### `agents delete <id>`

ลบเอเจนต์และตัดแต่งเวิร์กสเปซ+สถานะของมัน

ตัวเลือก:

- `--force`
- `--json`

### `acp`

รันบริดจ์ACPที่เชื่อมIDEกับGateway

ดู [`acp`](/cli/acp) สำหรับตัวเลือกและตัวอย่างทั้งหมด

### `status`

แสดงสุขภาพเซสชันที่เชื่อมโยงและผู้รับล่าสุด

ตัวเลือก:

- `--json`
- `--all` (การวินิจฉัยเต็มรูปแบบ; อ่านอย่างเดียว วางได้)
- `--deep` (โพรบช่องทาง)
- `--usage` (แสดงการใช้งาน/โควตาผู้ให้บริการโมเดล)
- `--timeout <ms>`
- `--verbose`
- `--debug` (นามแฝงของ `--verbose`)

หมายเหตุ:

- ภาพรวมรวมสถานะบริการGateway+โฮสต์โหนดเมื่อมีให้ใช้งาน

### การติดตามการใช้งาน

OpenClaw สามารถแสดงการใช้งาน/โควตาของผู้ให้บริการเมื่อมีข้อมูลรับรองOAuth/API

พื้นผิว:

- `/status` (เพิ่มบรรทัดการใช้งานสั้นๆเมื่อมี)
- `openclaw status --usage` (พิมพ์รายละเอียดผู้ให้บริการทั้งหมด)
- แถบเมนูmacOS (ส่วนUsageภายใต้Context)

หมายเหตุ:

- ข้อมูลมาจากเอ็นด์พอยต์การใช้งานของผู้ให้บริการโดยตรง (ไม่ประมาณ)
- ผู้ให้บริการ: Anthropic, GitHub Copilot, OpenAI Codex OAuth รวมถึง Gemini CLI/Antigravity เมื่อเปิดปลั๊กอินผู้ให้บริการเหล่านั้น
- หากไม่มีข้อมูลรับรองที่ตรงกัน การใช้งานจะถูกซ่อน
- รายละเอียด: ดู [Usage tracking](/concepts/usage-tracking)

### `health`

ดึงสุขภาพจากGatewayที่กำลังรันอยู่

ตัวเลือก:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

แสดงรายการเซสชันการสนทนาที่จัดเก็บไว้

ตัวเลือก:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## รีเซ็ต/ถอนการติดตั้ง

### `reset`

รีเซ็ตคอนฟิก/สถานะภายในเครื่อง (ยังคงติดตั้งCLIไว้)

ตัวเลือก:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

หมายเหตุ:

- `--non-interactive` ต้องใช้ `--scope` และ `--yes`

### `uninstall`

ถอนการติดตั้งบริการGateway+ข้อมูลภายในเครื่อง (CLIยังคงอยู่)

ตัวเลือก:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

หมายเหตุ:

- `--non-interactive` ต้องใช้ `--yes` และขอบเขตที่ระบุชัดเจน (หรือ `--all`)

## Gateway

### `gateway`

รันWebSocket Gateway

ตัวเลือก:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (รีเซ็ตคอนฟิกนักพัฒนา+ข้อมูลรับรอง+เซสชัน+เวิร์กสเปซ)
- `--force` (ฆ่าลิสเทนเนอร์เดิมบนพอร์ต)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (นามแฝงของ `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

จัดการบริการGateway (launchd/systemd/schtasks)

คำสั่งย่อย:

- `gateway status` (โพรบGatewayRPCโดยค่าเริ่มต้น)
- `gateway install` (ติดตั้งบริการ)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

หมายเหตุ:

- `gateway status` โพรบGatewayRPCโดยค่าเริ่มต้นโดยใช้พอร์ต/คอนฟิกที่บริการแก้ไขแล้ว (แทนที่ด้วย `--url/--token/--password`)
- `gateway status` รองรับ `--no-probe`, `--deep`, และ `--json` สำหรับการสคริปต์
- `gateway status` ยังแสดงบริการGatewayเดิมหรือเพิ่มเติมเมื่อสามารถตรวจพบได้ (`--deep` เพิ่มการสแกนระดับระบบ) บริการOpenClawที่ตั้งชื่อตามโปรไฟล์ถือเป็นชั้นหนึ่งและไม่ถูกทำเครื่องหมายว่า “เพิ่มเติม” บริการ OpenClaw ที่ตั้งชื่อตามโปรไฟล์จะถูกปฏิบัติเป็นระดับแรกและไม่ถูกทำเครื่องหมายว่าเป็น "extra".
- `gateway status` พิมพ์พาธคอนฟิกที่CLIใช้เทียบกับคอนฟิกที่บริการน่าจะใช้ (envของบริการ) พร้อมURLเป้าหมายโพรบที่แก้ไขแล้ว
- `gateway install|uninstall|start|stop|restart` รองรับ `--json` สำหรับการสคริปต์ (เอาต์พุตเริ่มต้นยังเป็นมิตรต่อมนุษย์)
- `gateway install` ค่าเริ่มต้นเป็นรันไทม์Node; **ไม่แนะนำ** bun (บั๊ก WhatsApp/Telegram)
- ตัวเลือก `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`

### `logs`

ติดตามไฟล์ล็อกGatewayผ่านRPC

หมายเหตุ:

- เซสชันTTYแสดงมุมมองแบบมีสีและมีโครงสร้าง; ไม่ใช่TTYจะถอยกลับเป็นข้อความธรรมดา
- `--json` ส่งJSONแบบคั่นบรรทัด (หนึ่งอีเวนต์ล็อกต่อบรรทัด)

ตัวอย่าง:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

ตัวช่วย Gateway CLI (ใช้ `--url`, `--token`, `--password`, `--timeout`, `--expect-final` สำหรับคำสั่งย่อย RPC).
ตัวช่วยGateway CLI (ใช้ `--url`, `--token`, `--password`, `--timeout`, `--expect-final` สำหรับคำสั่งย่อยRPC)
เมื่อส่ง `--url` CLIจะไม่ใช้คอนฟิกหรือข้อมูลรับรองจากสภาพแวดล้อมโดยอัตโนมัติ
ต้องระบุ `--token` หรือ `--password` อย่างชัดเจน การขาดข้อมูลรับรองที่ระบุชัดถือเป็นข้อผิดพลาด
ใส่ `--token` หรือ `--password` อย่างชัดเจน การขาดข้อมูลรับรองที่ระบุอย่างชัดเจนถือเป็นข้อผิดพลาด

คำสั่งย่อย:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

RPCที่ใช้บ่อย:

- `config.apply` (ตรวจสอบ+เขียนคอนฟิก+รีสตาร์ท+ปลุก)
- `config.patch` (ผสานการอัปเดตบางส่วน+รีสตาร์ท+ปลุก)
- `update.run` (รันอัปเดต+รีสตาร์ท+ปลุก)

เคล็ดลับ: เมื่อเรียก `config.set`/`config.apply`/`config.patch` โดยตรง ให้ส่ง `baseHash` จาก
`config.get` หากมีคอนฟิกอยู่แล้ว

## โมเดล

ดู [/concepts/models](/concepts/models) สำหรับพฤติกรรมการถอยกลับและกลยุทธ์การสแกน

การยืนยันตัวตนAnthropicที่แนะนำ (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (ราก)

`openclaw models` เป็นนามแฝงของ `models status`

ตัวเลือกราก:

- `--status-json` (นามแฝงของ `models status --json`)
- `--status-plain` (นามแฝงของ `models status --plain`)

### `models list`

ตัวเลือก:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

ตัวเลือก:

- `--json`
- `--plain`
- `--check` (ออกด้วยโค้ด 1=หมดอายุ/ขาด, 2=ใกล้หมดอายุ)
- `--probe` (โพรบสดของโปรไฟล์การยืนยันตัวตนที่กำหนดค่า)
- `--probe-provider <name>`
- `--probe-profile <id>` (ซ้ำหรือคั่นด้วยจุลภาค)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

จะรวมภาพรวมการยืนยันตัวตนและสถานะหมดอายุOAuthสำหรับโปรไฟล์ในที่เก็บการยืนยันตัวตนเสมอ
`--probe` จะรันคำขอสด (อาจใช้โทเคนและกระตุ้นลิมิตอัตรา)
`--probe` จะรันคำขอสด (อาจใช้โทเค็นและกระตุ้นข้อจำกัดอัตรา).

### `models set <model>`

ตั้งค่า `agents.defaults.model.primary`

### `models set-image <model>`

ตั้งค่า `agents.defaults.imageModel.primary`

### `models aliases list|add|remove`

ตัวเลือก:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

ตัวเลือก:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

ตัวเลือก:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

ตัวเลือก:

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

ตัวเลือก:

- `add`: ตัวช่วยการยืนยันตัวตนแบบโต้ตอบ
- `setup-token`: `--provider <name>` (ค่าเริ่มต้น `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

ตัวเลือก:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## ระบบ

### `system event`

จัดคิวอีเวนต์ระบบและเลือกทริกเกอร์ฮาร์ตบีต (GatewayRPC)

ต้องมี:

- `--text <text>`

ตัวเลือก:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

การควบคุมฮาร์ตบีต (GatewayRPC)

ตัวเลือก:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

แสดงรายการเอนทรีการมีอยู่ของระบบ (GatewayRPC)

ตัวเลือก:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

จัดการงานที่ตั้งเวลาไว้ (Gateway RPC). จัดการงานตามกำหนดเวลา (GatewayRPC) ดู [/automation/cron-jobs](/automation/cron-jobs)

คำสั่งย่อย:

- `cron status [--json]`
- `cron list [--all] [--json]` (ค่าเริ่มต้นเป็นตาราง; ใช้ `--json` สำหรับดิบ)
- `cron add` (นามแฝง: `create`; ต้องใช้ `--name` และหนึ่งอย่างจาก `--at` | `--every` | `--cron`, และหนึ่งเพย์โหลดจาก `--system-event` | `--message`)
- `cron edit <id>` (แพตช์ฟิลด์)
- `cron rm <id>` (นามแฝง: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

คำสั่ง `cron` ทั้งหมดรับ `--url`, `--token`, `--timeout`, `--expect-final`

## โฮสต์โหนด

`node` รัน **โฮสต์โหนดแบบไม่มีส่วนติดต่อ** หรือจัดการเป็นบริการเบื้องหลัง ดู
[`openclaw node`](/cli/node) ดู
[`openclaw node`](/cli/node).

คำสั่งย่อย:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## โหนด

`nodes` สื่อสารกับGatewayและกำหนดเป้าหมายโหนดที่จับคู่ ดู [/nodes](/nodes) See [/nodes](/nodes).

ตัวเลือกทั่วไป:

- `--url`, `--token`, `--timeout`, `--json`

คำสั่งย่อย:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (โหนดmacหรือโฮสต์โหนดแบบไม่มีส่วนติดต่อ)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (เฉพาะmac)

กล้อง:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

ผ้าใบ+หน้าจอ:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

ตำแหน่งที่ตั้ง:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## เบราว์เซอร์

CLIควบคุมเบราว์เซอร์ (Chrome/Brave/Edge/Chromiumแบบเฉพาะ) ดู [`openclaw browser`](/cli/browser) และ [เครื่องมือBrowser](/tools/browser) ดู [`openclaw browser`](/cli/browser) และ [เครื่องมือ Browser](/tools/browser).

ตัวเลือกทั่วไป:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

จัดการ:

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

ตรวจสอบ:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

การกระทำ:

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

## การค้นหาเอกสาร

### `docs [query...]`

ค้นหาดัชนีเอกสารแบบสด

## TUI

### `tui`

เปิดUIเทอร์มินัลที่เชื่อมต่อกับGateway

ตัวเลือก:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (ค่าเริ่มต้นเป็น `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
