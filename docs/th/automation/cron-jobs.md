---
summary: "งาน Cron + การปลุกสำหรับตัวจัดตารางเวลาGateway"
read_when:
  - การตั้งเวลางานเบื้องหลังหรือการปลุก
  - การเชื่อมระบบอัตโนมัติที่ควรรันพร้อมหรือร่วมกับฮาร์ตบีต
  - การตัดสินใจเลือกระหว่างฮาร์ตบีตกับ cron สำหรับงานที่ตั้งเวลา
title: "Cron Jobs"
---

# Cron jobs (Gateway scheduler)

> **Cron vs Heartbeat?** ดู [Cron vs Heartbeat](/automation/cron-vs-heartbeat) สำหรับคำแนะนำในการเลือกใช้อย่างเหมาะสม

Cron is the Gateway’s built-in scheduler. Cron คือระบบตั้งเวลาในตัวของ Gateway มันจัดเก็บงานไว้ ปลุกเอเจนต์ในเวลาที่เหมาะสม และสามารถส่งเอาต์พุตกลับไปยังแชตได้ตามต้องการ

หากคุณต้องการ _“รันทุกเช้า”_ หรือ _“สะกิดเอเจนต์ในอีก 20 นาที”_ cron คือกลไกที่เหมาะสม

การแก้ไขปัญหา: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron ทำงาน **ภายใน Gateway** (ไม่ใช่ภายในโมเดล)
- งานจะถูกจัดเก็บถาวรภายใต้ `~/.openclaw/cron/` ดังนั้นการรีสตาร์ตจะไม่ทำให้ตารางหาย
- รูปแบบการรันสองแบบ:
  - **เซสชันหลัก**: เข้าคิวอีเวนต์ระบบ แล้วรันในฮาร์ตบีตถัดไป
  - **แยกอิสระ**: รันเทิร์นเอเจนต์เฉพาะใน `cron:<jobId>` พร้อมการส่งมอบ (ประกาศเป็นค่าเริ่มต้นหรือไม่ส่ง)
- การปลุกเป็นพลเมืองชั้นหนึ่ง: งานสามารถขอ “ปลุกตอนนี้” เทียบกับ “ฮาร์ตบีตถัดไป”

## เริ่มต้นอย่างรวดเร็ว (ลงมือทำได้ทันที)

สร้างการเตือนแบบครั้งเดียว ตรวจสอบว่ามีอยู่ และสั่งรันทันที:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

ตั้งเวลางานแบบแยกอิสระที่ทำซ้ำพร้อมการส่งมอบ:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## รูปแบบเทียบเท่าการเรียกเครื่องมือ (Gateway cron tool)

สำหรับรูปแบบ JSON มาตรฐานและตัวอย่าง ดู [JSON schema สำหรับการเรียกเครื่องมือ](/automation/cron-jobs#json-schema-for-tool-calls)

## ที่จัดเก็บงาน cron

Cron jobs are persisted on the Gateway host at `~/.openclaw/cron/jobs.json` by default.
งาน cron จะถูกจัดเก็บถาวรบนโฮสต์Gateway ที่ `~/.openclaw/cron/jobs.json` โดยค่าเริ่มต้น
Gateway จะโหลดไฟล์เข้าสู่หน่วยความจำและเขียนกลับเมื่อมีการเปลี่ยนแปลง ดังนั้นการแก้ไขด้วยมือ
จะปลอดภัยก็ต่อเมื่อ Gateway หยุดทำงานแล้วเท่านั้น แนะนำให้ใช้ `openclaw cron add/edit` หรือ
API การเรียกเครื่องมือ cron สำหรับการเปลี่ยนแปลง Prefer `openclaw cron add/edit` or the cron
tool call API for changes.

## ภาพรวมสำหรับผู้เริ่มต้น

คิดว่างาน cron คือ: **เมื่อไร** ที่จะรัน + **ทำอะไร**

1. **เลือกตารางเวลา**
   - การเตือนแบบครั้งเดียว → `schedule.kind = "at"` (CLI: `--at`)
   - งานที่ทำซ้ำ → `schedule.kind = "every"` หรือ `schedule.kind = "cron"`
   - หากเวลาแบบ ISO ไม่ระบุโซนเวลา จะถือเป็น **UTC**

2. **เลือกตำแหน่งที่รัน**
   - `sessionTarget: "main"` → รันระหว่างฮาร์ตบีตถัดไปพร้อมบริบทหลัก
   - `sessionTarget: "isolated"` → รันเทิร์นเอเจนต์เฉพาะใน `cron:<jobId>`

3. **เลือกเพย์โหลด**
   - เซสชันหลัก → `payload.kind = "systemEvent"`
   - เซสชันแยกอิสระ → `payload.kind = "agentTurn"`

ไม่บังคับ: งานแบบครั้งเดียว (`schedule.kind = "at"`) จะลบหลังสำเร็จเป็นค่าเริ่มต้น ตั้งค่า
`deleteAfterRun: false` เพื่อเก็บไว้ (งานจะถูกปิดใช้งานหลังสำเร็จ) Set
`deleteAfterRun: false` to keep them (they will disable after success).

## แนวคิด

### งาน (Jobs)

งาน cron คือระเบียนที่จัดเก็บซึ่งประกอบด้วย:

- **ตารางเวลา** (ควรรันเมื่อไร)
- **เพย์โหลด** (ควรทำอะไร)
- **โหมดการส่งมอบ** แบบไม่บังคับ (ประกาศหรือไม่ส่ง)
- **การผูกเอเจนต์** แบบไม่บังคับ (`agentId`): รันงานภายใต้เอเจนต์เฉพาะ หากขาดหายหรือไม่รู้จัก Gateway จะใช้เอเจนต์เริ่มต้น

Jobs are identified by a stable `jobId` (used by CLI/Gateway APIs).
In agent tool calls, `jobId` is canonical; legacy `id` is accepted for compatibility.
One-shot jobs auto-delete after success by default; set `deleteAfterRun: false` to keep them.

### ตารางเวลา (Schedules)

Cron รองรับตารางเวลาสามประเภท:

- `at`: เวลาแบบครั้งเดียวผ่าน `schedule.at` (ISO 8601)
- `every`: ช่วงเวลาคงที่ (มิลลิวินาที)
- `cron`: นิพจน์ cron 5 ฟิลด์ พร้อมโซนเวลา IANA แบบไม่บังคับ

Cron expressions use `croner`. นิพจน์ cron ใช้ `croner` หากไม่ระบุโซนเวลา จะใช้โซนเวลาท้องถิ่นของโฮสต์Gateway

### การรันแบบหลัก vs แบบแยกอิสระ

#### งานเซสชันหลัก (อีเวนต์ระบบ)

Main jobs enqueue a system event and optionally wake the heartbeat runner.
งานหลักจะเข้าคิวอีเวนต์ระบบและสามารถปลุกตัวรันฮาร์ตบีตได้ตามต้องการ
ต้องใช้ `payload.kind = "systemEvent"`

- `wakeMode: "now"` (ค่าเริ่มต้น): อีเวนต์จะกระตุ้นให้รันฮาร์ตบีตทันที
- `wakeMode: "next-heartbeat"`: อีเวนต์จะรอฮาร์ตบีตตามกำหนดถัดไป

เหมาะที่สุดเมื่อคุณต้องการพรอมต์ฮาร์ตบีตปกติพร้อมบริบทเซสชันหลัก
ดู [Heartbeat](/gateway/heartbeat)
See [Heartbeat](/gateway/heartbeat).

#### งานแยกอิสระ (เซสชัน cron เฉพาะ)

งานแยกอิสระจะรันเทิร์นเอเจนต์เฉพาะในเซสชัน `cron:<jobId>`

พฤติกรรมสำคัญ:

- พรอมต์จะมีคำนำหน้า `[cron:<jobId> <job name>]` เพื่อการติดตาม
- แต่ละการรันเริ่มด้วย **session id ใหม่** (ไม่มีการสืบทอดบทสนทนาก่อนหน้า)
- พฤติกรรมเริ่มต้น: หากไม่ระบุ `delivery` งานแยกอิสระจะประกาศสรุป (`delivery.mode = "announce"`)
- `delivery.mode` (เฉพาะงานแยกอิสระ) ใช้กำหนดสิ่งที่จะเกิดขึ้น:
  - `announce`: ส่งสรุปไปยังช่องทางเป้าหมายและโพสต์สรุปสั้นไปยังเซสชันหลัก
  - `none`: ภายในเท่านั้น (ไม่ส่ง ไม่สรุปไปยังเซสชันหลัก)
- `wakeMode` ควบคุมเวลาที่โพสต์สรุปในเซสชันหลัก:
  - `now`: ฮาร์ตบีตทันที
  - `next-heartbeat`: รอฮาร์ตบีตตามกำหนดถัดไป

ใช้ งานแยกอิสระ สำหรับงานที่มีเสียงดัง ถี่ หรือเป็น “งานเบื้องหลัง” ที่ไม่ควรรบกวนประวัติแชตหลัก

### รูปแบบเพย์โหลด (สิ่งที่รัน)

รองรับเพย์โหลดสองประเภท:

- `systemEvent`: เฉพาะเซสชันหลัก ส่งผ่านพรอมต์ฮาร์ตบีต
- `agentTurn`: เฉพาะเซสชันแยกอิสระ รันเทิร์นเอเจนต์เฉพาะ

ฟิลด์ `agentTurn` ที่ใช้ร่วมกัน:

- `message`: ข้อความพรอมต์ที่จำเป็น
- `model` / `thinking`: การโอเวอร์ไรด์แบบไม่บังคับ (ดูด้านล่าง)
- `timeoutSeconds`: การโอเวอร์ไรด์เวลาไทม์เอาต์แบบไม่บังคับ

คอนฟิกการส่งมอบ (เฉพาะงานแยกอิสระ):

- `delivery.mode`: `none` | `announce`
- `delivery.channel`: `last` หรือช่องทางเฉพาะ
- `delivery.to`: เป้าหมายเฉพาะช่องทาง (โทรศัพท์/แชต/ไอดีช่อง)
- `delivery.bestEffort`: หลีกเลี่ยงการทำให้งานล้มเหลวหากการประกาศล้มเหลว

การประกาศจะระงับการส่งผ่านเครื่องมือส่งข้อความสำหรับการรันนั้น ใช้ `delivery.channel`/`delivery.to`
เพื่อกำหนดเป้าหมายไปยังแชตแทน เมื่อเป็น `delivery.mode = "none"` จะไม่โพสต์สรุปไปยังเซสชันหลัก When `delivery.mode = "none"`, no summary is posted to the main session.

หากไม่ระบุ `delivery` สำหรับงานแยกอิสระ OpenClaw จะตั้งค่าเริ่มต้นเป็น `announce`

#### โฟลว์การส่งมอบแบบประกาศ

เมื่อเป็น `delivery.mode = "announce"` cron จะส่งมอบโดยตรงผ่านอะแดปเตอร์ช่องทางขาออก
เอเจนต์หลักจะไม่ถูกเรียกขึ้นมาเพื่อร่างหรือส่งต่อข้อความ
The main agent is not spun up to craft or forward the message.

รายละเอียดพฤติกรรม:

- เนื้อหา: การส่งมอบใช้เพย์โหลดขาออกของการรันแยกอิสระ (ข้อความ/สื่อ) พร้อมการแบ่งชิ้นและรูปแบบช่องทางตามปกติ
- การตอบกลับเฉพาะฮาร์ตบีต (`HEARTBEAT_OK` ที่ไม่มีเนื้อหาจริง) จะไม่ถูกส่งมอบ
- หากการรันแยกอิสระได้ส่งข้อความไปยังเป้าหมายเดียวกันผ่านเครื่องมือส่งข้อความแล้ว การส่งมอบจะถูกข้ามเพื่อหลีกเลี่ยงซ้ำ
- เป้าหมายการส่งมอบที่หายไปหรือไม่ถูกต้องจะทำให้งานล้มเหลว เว้นแต่เป็น `delivery.bestEffort = true`
- จะโพสต์สรุปสั้นไปยังเซสชันหลักเฉพาะเมื่อเป็น `delivery.mode = "announce"`
- สรุปในเซสชันหลักเคารพ `wakeMode`: `now` จะกระตุ้นฮาร์ตบีตทันที และ
  `next-heartbeat` จะรอฮาร์ตบีตตามกำหนดถัดไป

### การโอเวอร์ไรด์โมเดลและระดับการคิด

งานแยกอิสระ (`agentTurn`) สามารถโอเวอร์ไรด์โมเดลและระดับการคิดได้:

- `model`: สตริงผู้ให้บริการ/โมเดล (เช่น `anthropic/claude-sonnet-4-20250514`) หรือชื่อแทน (เช่น `opus`)
- `thinking`: ระดับการคิด (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; เฉพาะโมเดล GPT-5.2 + Codex)

หมายเหตุ: คุณสามารถตั้งค่า `model` กับงานเซสชันหลักได้เช่นกัน แต่จะเปลี่ยนโมเดลของเซสชันหลักที่ใช้ร่วมกัน เราแนะนำให้โอเวอร์ไรด์โมเดลเฉพาะงานแยกอิสระเพื่อหลีกเลี่ยงการเปลี่ยนบริบทโดยไม่คาดคิด We recommend model overrides only for isolated jobs to avoid
unexpected context shifts.

ลำดับความสำคัญของการตัดสินใจ:

1. การโอเวอร์ไรด์ในเพย์โหลดของงาน (สูงสุด)
2. ค่าเริ่มต้นเฉพาะฮุค (เช่น `hooks.gmail.model`)
3. ค่าเริ่มต้นในคอนฟิกเอเจนต์

### การส่งมอบ (ช่องทาง + เป้าหมาย)

งานแยกอิสระสามารถส่งเอาต์พุตไปยังช่องทางผ่านคอนฟิกระดับบน `delivery`:

- `delivery.mode`: `announce` (ส่งสรุป) หรือ `none`
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (ปลั๊กอิน) / `signal` / `imessage` / `last`
- `delivery.to`: เป้าหมายผู้รับเฉพาะช่องทาง

คอนฟิกการส่งมอบใช้ได้เฉพาะงานแยกอิสระ (`sessionTarget: "isolated"`)

หากไม่ระบุ `delivery.channel` หรือ `delivery.to` cron สามารถย้อนกลับไปใช้ “เส้นทางล่าสุด”
ของเซสชันหลักได้ (สถานที่ล่าสุดที่เอเจนต์ตอบ)

ข้อเตือนใจรูปแบบเป้าหมาย:

- เป้าหมาย Slack/Discord/Mattermost (ปลั๊กอิน) ควรใช้คำนำหน้าที่ชัดเจน (เช่น `channel:<id>`, `user:<id>`) เพื่อหลีกเลี่ยงความกำกวม
- หัวข้อ Telegram ควรใช้รูปแบบ `:topic:` (ดูด้านล่าง)

#### เป้าหมายการส่งมอบ Telegram (หัวข้อ / เธรดฟอรัม)

Telegram supports forum topics via `message_thread_id`. Telegram รองรับหัวข้อฟอรัมผ่าน `message_thread_id` สำหรับการส่งมอบด้วย cron คุณสามารถเข้ารหัสหัวข้อ/เธรดไว้ในฟิลด์ `to`:

- `-1001234567890` (เฉพาะ chat id)
- `-1001234567890:topic:123` (แนะนำ: ตัวระบุหัวข้อแบบชัดเจน)
- `-1001234567890:123` (แบบย่อ: ต่อท้ายตัวเลข)

เป้าหมายที่มีคำนำหน้าอย่าง `telegram:...` / `telegram:group:...` ก็รองรับเช่นกัน:

- `telegram:group:-1001234567890:topic:123`

## JSON schema สำหรับการเรียกเครื่องมือ

ใช้รูปแบบเหล่านี้เมื่อเรียกเครื่องมือ Gateway `cron.*` โดยตรง (การเรียกเครื่องมือของเอเจนต์หรือ RPC)
แฟล็ก CLI รองรับระยะเวลาแบบอ่านง่าย เช่น `20m` แต่การเรียกเครื่องมือควรใช้สตริง ISO 8601
สำหรับ `schedule.at` และมิลลิวินาทีสำหรับ `schedule.everyMs`
CLI flags accept human durations like `20m`, but tool calls should use an ISO 8601 string
for `schedule.at` and milliseconds for `schedule.everyMs`.

### พารามิเตอร์ cron.add

งานครั้งเดียว เซสชันหลัก (อีเวนต์ระบบ):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

งานทำซ้ำ แยกอิสระ พร้อมการส่งมอบ:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

หมายเหตุ:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), หรือ `cron` (`expr`, `tz` แบบไม่บังคับ)
- `schedule.at` รองรับ ISO 8601 (โซนเวลาไม่บังคับ; หากไม่ระบุจะถือเป็น UTC)
- `everyMs` คือมิลลิวินาที
- `sessionTarget` ต้องเป็น `"main"` หรือ `"isolated"` และต้องสอดคล้องกับ `payload.kind`
- ฟิลด์ไม่บังคับ: `agentId`, `description`, `enabled`, `deleteAfterRun` (ค่าเริ่มต้นเป็น true สำหรับ `at`),
  `delivery`
- `wakeMode` จะตั้งค่าเริ่มต้นเป็น `"now"` เมื่อไม่ระบุ

### พารามิเตอร์ cron.update

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

หมายเหตุ:

- `jobId` เป็นรูปแบบหลัก; `id` รองรับเพื่อความเข้ากันได้
- ใช้ `agentId: null` ในแพตช์เพื่อเคลียร์การผูกเอเจนต์

### พารามิเตอร์ cron.run และ cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## การจัดเก็บและประวัติ

- ที่เก็บงาน: `~/.openclaw/cron/jobs.json` (JSON ที่ Gateway จัดการ)
- ประวัติการรัน: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, ล้างอัตโนมัติ)
- โอเวอร์ไรด์พาธที่เก็บ: `cron.store` ในคอนฟิก

## การกำหนดค่า

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

ปิดการใช้งาน cron ทั้งหมด:

- `cron.enabled: false` (คอนฟิก)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI เริ่มต้นอย่างรวดเร็ว

การเตือนแบบครั้งเดียว (UTC ISO, ลบอัตโนมัติหลังสำเร็จ):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

การเตือนแบบครั้งเดียว (เซสชันหลัก ปลุกทันที):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

งานแยกอิสระแบบทำซ้ำ (ประกาศไปยัง WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

งานแยกอิสระแบบทำซ้ำ (ส่งไปยังหัวข้อ Telegram):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

งานแยกอิสระพร้อมโอเวอร์ไรด์โมเดลและระดับการคิด:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

การเลือกเอเจนต์ (การตั้งค่าหลายเอเจนต์):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

การรันด้วยมือ (force เป็นค่าเริ่มต้น ใช้ `--due` เพื่อรันเฉพาะเมื่อถึงกำหนด):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

แก้ไขงานที่มีอยู่ (แพตช์ฟิลด์):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

ประวัติการรัน:

```bash
openclaw cron runs --id <jobId> --limit 50
```

อีเวนต์ระบบทันทีโดยไม่สร้างงาน:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## พื้นผิว API ของ Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force หรือ due), `cron.runs`
  สำหรับอีเวนต์ระบบทันทีโดยไม่ต้องมีงาน ใช้ [`openclaw system event`](/cli/system)

## การแก้ไขปัญหา

### “ไม่มีอะไรรัน”

- ตรวจสอบว่า cron เปิดใช้งานอยู่: `cron.enabled` และ `OPENCLAW_SKIP_CRON`
- ตรวจสอบว่า Gateway ทำงานต่อเนื่อง (cron ทำงานภายในโปรเซสGateway)
- สำหรับตาราง `cron`: ยืนยันโซนเวลา (`--tz`) เทียบกับโซนเวลาของโฮสต์

### งานทำซ้ำเลื่อนออกไปเรื่อยๆหลังเกิดความล้มเหลว

- OpenClaw ใช้การหน่วงรีทรายแบบเอ็กซ์โปเนนเชียลสำหรับงานทำซ้ำหลังเกิดข้อผิดพลาดต่อเนื่อง:
  30วินาที, 1นาที, 5นาที, 15นาที แล้วเป็น 60นาทีระหว่างการลองใหม่
- การหน่วงจะรีเซ็ตอัตโนมัติหลังการรันที่สำเร็จครั้งถัดไป
- งานแบบครั้งเดียว (`at`) จะปิดใช้งานหลังการรันแบบสิ้นสุด (`ok`, `error`, หรือ `skipped`) และจะไม่ลองใหม่

### Telegram ส่งไปผิดที่

- สำหรับหัวข้อฟอรัม ให้ใช้ `-100…:topic:<id>` เพื่อให้ชัดเจนไม่กำกวม
- หากเห็นคำนำหน้า `telegram:...` ในล็อกหรือในเป้าหมาย “เส้นทางล่าสุด” ที่จัดเก็บ นั่นเป็นเรื่องปกติ;
  การส่งมอบด้วย cron รองรับและยังคงแยกวิเคราะห์ไอดีหัวข้อได้ถูกต้อง
