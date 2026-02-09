---
summary: "ข้อความโพลลิงHeartbeatและกฎการแจ้งเตือน"
read_when:
  - ปรับจังหวะHeartbeatหรือการส่งข้อความ
  - ตัดสินใจเลือกระหว่างHeartbeatและcronสำหรับงานตามกำหนดเวลา
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** ดู [Cron vs Heartbeat](/automation/cron-vs-heartbeat) เพื่อคำแนะนำในการเลือกใช้งานแต่ละแบบ

Heartbeatจะรัน **agent turns แบบเป็นระยะ** ในเซสชันหลัก เพื่อให้โมเดลสามารถ
ชี้ประเด็นที่ต้องให้ความสนใจได้โดยไม่สแปมคุณ

การแก้ไขปัญหา: [/automation/troubleshooting](/automation/troubleshooting)

## เริ่มต้นอย่างรวดเร็ว(ผู้เริ่มต้น)

1. ปล่อยให้Heartbeatเปิดใช้งานอยู่(ค่าเริ่มต้นคือ `30m` หรือ `1h` สำหรับ Anthropic OAuth/setup-token)หรือกำหนดจังหวะเอง
2. สร้างเช็กลิสต์ `HEARTBEAT.md` ขนาดเล็กในเวิร์กสเปซของเอเจนต์(ไม่บังคับแต่แนะนำ)
3. ตัดสินใจว่าจะให้ข้อความHeartbeatไปที่ใด(`target: "last"`เป็นค่าเริ่มต้น)
4. ไม่บังคับ: เปิดการส่งเหตุผลของHeartbeatเพื่อความโปร่งใส
5. ไม่บังคับ: จำกัดHeartbeatให้ทำงานเฉพาะช่วงเวลาที่ใช้งานอยู่(เวลาท้องถิ่น)

ตัวอย่างคอนฟิก:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## ค่าเริ่มต้น

- ช่วงเวลา: `30m` (หรือ `1h` เมื่อโหมดการยืนยันตัวตนที่ตรวจพบคือ Anthropic OAuth/setup-token) ตั้งค่า `agents.defaults.heartbeat.every` หรือแบบต่อเอเจนต์ `agents.list[].heartbeat.every`; ใช้ `0m` เพื่อปิดใช้งาน Set `agents.defaults.heartbeat.every` or per-agent `agents.list[].heartbeat.every`; use `0m` to disable.
- เนื้อหาPrompt (ปรับได้ผ่าน `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- PromptของHeartbeatจะถูกส่ง **ตามต้นฉบับ** เป็นข้อความผู้ใช้ โดยsystem prompt
  จะมีส่วน “Heartbeat” และการรันจะถูกทำเครื่องหมายภายใน The system
  prompt includes a “Heartbeat” section and the run is flagged internally.
- ชั่วโมงที่ใช้งานอยู่(`heartbeat.activeHours`)จะถูกตรวจสอบตามโซนเวลาที่กำหนด
  นอกช่วงเวลาดังกล่าวHeartbeatจะถูกข้ามจนกว่าจะถึงรอบถัดไปที่อยู่ในช่วงเวลา
  Outside the window, heartbeats are skipped until the next tick inside the window.

## PromptของHeartbeatใช้เพื่ออะไร

Promptเริ่มต้นถูกออกแบบให้กว้างโดยตั้งใจ:

- **งานเบื้องหลัง**: “Consider outstanding tasks” กระตุ้นให้เอเจนต์ทบทวน
  งานติดตาม(กล่องจดหมาย ปฏิทิน การเตือน งานที่ค้าง)และชี้สิ่งเร่งด่วน
- **เช็กอินกับมนุษย์**: “Checkup sometimes on your human during day time” กระตุ้น
  ข้อความเบาๆเป็นครั้งคราวเช่น “มีอะไรให้ช่วยไหม?” แต่หลีกเลี่ยงการสแปมตอนกลางคืน
  โดยใช้โซนเวลาท้องถิ่นที่คุณตั้งค่า(ดู [/concepts/timezone](/concepts/timezone))

หากต้องการให้Heartbeatทำสิ่งเฉพาะเจาะจงมากๆ(เช่น “ตรวจสถิติ Gmail PubSub”
หรือ “ตรวจสอบสุขภาพGateway”) ให้ตั้งค่า `agents.defaults.heartbeat.prompt` (หรือ
`agents.list[].heartbeat.prompt`) เป็นเนื้อหาที่กำหนดเอง(ส่งตามต้นฉบับ)

## สัญญาการตอบกลับ

- หากไม่มีสิ่งที่ต้องให้ความสนใจ ให้ตอบด้วย **`HEARTBEAT_OK`**
- ระหว่างการรันHeartbeat OpenClawจะถือว่า `HEARTBEAT_OK` เป็นการยืนยัน(ack)เมื่อปรากฏ
  ที่ **ต้นหรือท้าย** ของคำตอบ โทเคนจะถูกตัดออกและคำตอบจะถูกทิ้งหากเนื้อหาที่เหลือ
  **≤ `ackMaxChars`** (ค่าเริ่มต้น: 300) The token is stripped and the reply is
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 300).
- หาก `HEARTBEAT_OK` ปรากฏอยู่ **กลาง** คำตอบ จะไม่ถูกปฏิบัติเป็นพิเศษ
- สำหรับการแจ้งเตือน **อย่า** ใส่ `HEARTBEAT_OK`; ให้ส่งเฉพาะข้อความแจ้งเตือน

นอกเหนือจากHeartbeat หากมี `HEARTBEAT_OK` หลงเหลือที่ต้น/ท้ายของข้อความจะถูกตัดออก
และบันทึกไว้; ข้อความที่มีเพียง `HEARTBEAT_OK` จะถูกทิ้ง

## คอนฟิก

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### ขอบเขตและลำดับความสำคัญ

- `agents.defaults.heartbeat` กำหนดพฤติกรรมHeartbeatระดับส่วนกลาง
- `agents.list[].heartbeat` จะถูกรวมทับ; หากเอเจนต์ใดมีบล็อก `heartbeat` จะมี **เฉพาะเอเจนต์เหล่านั้น** ที่รันHeartbeat
- `channels.defaults.heartbeat` กำหนดค่าเริ่มต้นการมองเห็นสำหรับทุกช่องทาง
- `channels.<channel>.heartbeat` แทนที่ค่าเริ่มต้นของช่องทาง
- `channels.<channel>.accounts.<id>.heartbeat` (ช่องทางหลายบัญชี) แทนที่ค่าต่อช่องทาง

### Heartbeatต่อเอเจนต์

หากมีรายการ `agents.list[]` ใดที่มีบล็อก `heartbeat` จะมี **เฉพาะเอเจนต์เหล่านั้น**
ที่รันHeartbeat บล็อกต่อเอเจนต์จะถูกรวมทับบน `agents.defaults.heartbeat`
(ดังนั้นคุณสามารถตั้งค่าร่วมครั้งเดียวและแทนที่ต่อเอเจนต์ได้) The per-agent block merges on top of `agents.defaults.heartbeat`
(so you can set shared defaults once and override per agent).

ตัวอย่าง: เอเจนต์สองตัว มีเพียงตัวที่สองที่รันHeartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### ตัวอย่างชั่วโมงที่ใช้งานอยู่

จำกัดHeartbeatให้ทำงานในชั่วโมงทำการตามโซนเวลาที่ระบุ:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

นอกช่วงเวลานี้(ก่อน9โมงเช้าหรือหลัง4ทุ่มตามเวลาEastern)Heartbeatจะถูกข้าม
รอบถัดไปที่อยู่ในช่วงเวลาจะทำงานตามปกติ The next scheduled tick inside the window will run normally.

### ตัวอย่างหลายบัญชี

ใช้ `accountId` เพื่อกำหนดเป้าหมายบัญชีเฉพาะบนช่องทางหลายบัญชีอย่าง Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### หมายเหตุฟิลด์

- `every`: ช่วงเวลาHeartbeat (สตริงระยะเวลา; หน่วยเริ่มต้น=นาที)
- `model`: ตัวเลือกแทนที่โมเดลสำหรับการรันHeartbeat (`provider/model`)
- `includeReasoning`: เมื่อเปิดใช้งาน จะส่งข้อความ `Reasoning:` แยกต่างหากเมื่อมี (รูปแบบเดียวกับ `/reasoning on`)
- `session`: คีย์เซสชันตัวเลือกสำหรับการรันHeartbeat
  - `main` (ค่าเริ่มต้น): เซสชันหลักของเอเจนต์
  - คีย์เซสชันที่ระบุชัดเจน(คัดลอกจาก `openclaw sessions --json` หรือ [sessions CLI](/cli/sessions))
  - รูปแบบคีย์เซสชัน: ดู [Sessions](/concepts/session) และ [Groups](/channels/groups)
- `target`:
  - `last` (ค่าเริ่มต้น): ส่งไปยังช่องทางภายนอกที่ใช้ล่าสุด
  - ช่องทางที่ระบุชัดเจน: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`
  - `none`: รันHeartbeatแต่ **ไม่ส่งออก** ภายนอก
- `to`: ตัวเลือกแทนที่ผู้รับ(idเฉพาะช่องทาง เช่น E.164 สำหรับ WhatsApp หรือ chat id ของ Telegram)
- `accountId`: optional account id for multi-account channels. `accountId`: ตัวเลือกidบัญชีสำหรับช่องทางหลายบัญชี เมื่อ `target: "last"` idบัญชีจะถูกใช้กับช่องทางล่าสุดที่รองรับบัญชี; มิฉะนั้นจะถูกละเว้น หากidบัญชีไม่ตรงกับบัญชีที่คอนฟิกไว้สำหรับช่องทางนั้น การส่งจะถูกข้าม If the account id does not match a configured account for the resolved channel, delivery is skipped.
- `prompt`: แทนที่เนื้อหาpromptเริ่มต้น(ไม่ถูกรวม)
- `ackMaxChars`: จำนวนอักขระสูงสุดที่อนุญาตหลัง `HEARTBEAT_OK` ก่อนส่ง
- `activeHours`: restricts heartbeat runs to a time window. `activeHours`: จำกัดการรันHeartbeatให้อยู่ในช่วงเวลา อ็อบเจ็กต์ที่มี `start` (HH:MM รวม), `end` (HH:MM ไม่รวม; อนุญาต `24:00` สำหรับสิ้นวัน), และตัวเลือก `timezone`
  - หากละเว้นหรือเป็น `"user"`: ใช้ `agents.defaults.userTimezone` ของคุณหากตั้งไว้ มิฉะนั้นใช้โซนเวลาระบบโฮสต์
  - `"local"`: ใช้โซนเวลาระบบโฮสต์เสมอ
  - ตัวระบุIANAใดๆ(เช่น `America/New_York`): ใช้โดยตรง; หากไม่ถูกต้องจะย้อนกลับไปใช้พฤติกรรม `"user"` ข้างต้น
  - นอกช่วงเวลาที่ใช้งานอยู่ Heartbeatจะถูกข้ามจนกว่าจะถึงรอบถัดไปในช่วงเวลา

## พฤติกรรมการส่งมอบ

- Heartbeatจะรันในเซสชันหลักของเอเจนต์ตามค่าเริ่มต้น(`agent:<id>:<mainKey>`)
  หรือ `global` เมื่อ `session.scope = "global"` ตั้งค่า `session` เพื่อแทนที่ไปยัง
  เซสชันช่องทางเฉพาะ(Discord/WhatsApp/etc.) Set `session` to override to a
  specific channel session (Discord/WhatsApp/etc.).
- `session` มีผลเฉพาะบริบทการรัน; การส่งมอบถูกควบคุมโดย `target` และ `to`
- To deliver to a specific channel/recipient, set `target` + `to`. หากต้องการส่งไปยังช่องทาง/ผู้รับเฉพาะ ให้ตั้งค่า `target` + `to` พร้อมกับ
  `target: "last"` การส่งจะใช้ช่องทางภายนอกล่าสุดสำหรับเซสชันนั้น
- หากคิวหลักไม่ว่าง Heartbeatจะถูกข้ามและลองใหม่ภายหลัง
- หาก `target` แก้ไขแล้วไม่พบปลายทางภายนอก การรันยังเกิดขึ้นแต่จะไม่มีข้อความออก
- คำตอบเฉพาะHeartbeatจะ **ไม่** ทำให้เซสชันคงอยู่; `updatedAt` ล่าสุดจะถูกกู้คืน
  เพื่อให้การหมดอายุเมื่อไม่ใช้งานทำงานตามปกติ

## การควบคุมการมองเห็น

ตามค่าเริ่มต้น การยืนยัน `HEARTBEAT_OK` จะถูกซ่อน ขณะที่เนื้อหาการแจ้งเตือนจะถูกส่ง
คุณสามารถปรับต่อช่องทางหรือบัญชีได้: You can adjust this per channel or per account:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

ลำดับความสำคัญ: ต่อบัญชี → ต่อช่องทาง → ค่าเริ่มต้นของช่องทาง → ค่าเริ่มต้นในตัวระบบ

### แต่ละแฟล็กทำอะไร

- `showOk`: ส่งการยืนยัน `HEARTBEAT_OK` เมื่อโมเดลส่งคำตอบที่เป็นOKเท่านั้น
- `showAlerts`: ส่งเนื้อหาการแจ้งเตือนเมื่อโมเดลส่งคำตอบที่ไม่ใช่OK
- `useIndicator`: ปล่อยอีเวนต์ตัวบ่งชี้สำหรับพื้นผิวสถานะของUI

หาก **ทั้งสาม** เป็น false OpenClawจะข้ามการรันHeartbeatทั้งหมด(ไม่เรียกโมเดล)

### ตัวอย่างต่อช่องทาง vs ต่อบัญชี

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### รูปแบบที่พบบ่อย

| เป้าหมาย                                                     | คอนฟิก                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| พฤติกรรมเริ่มต้น(OKเงียบ แจ้งเตือนเปิด)   | _(ไม่ต้องตั้งค่า)_                                                    |
| เงียบทั้งหมด(ไม่มีข้อความ ไม่มีตัวบ่งชี้) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| เฉพาะตัวบ่งชี้(ไม่มีข้อความ)              | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKเฉพาะช่องทางเดียว                                          | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (ไม่บังคับ)

หากมีไฟล์ `HEARTBEAT.md` อยู่ในเวิร์กสเปซ Promptเริ่มต้นจะบอกให้เอเจนต์อ่านไฟล์นั้น
คิดซะว่าเป็น “เช็กลิสต์Heartbeat” ของคุณ: เล็ก คงที่ และปลอดภัยที่จะใส่ทุก30นาที Think of it as your “heartbeat checklist”: small, stable, and
safe to include every 30 minutes.

หากมี `HEARTBEAT.md` อยู่แต่แทบว่างเปล่า(มีเพียงบรรทัดว่างและหัวข้อmarkdownอย่าง `# Heading`)
OpenClawจะข้ามการรันHeartbeatเพื่อประหยัดการเรียกAPI หากไฟล์หายไป Heartbeatยังคงรัน
และโมเดลจะตัดสินใจเองว่าจะทำอะไร
หากไฟล์หายไป ฮาร์ตบีตยังคงรันและโมเดลจะตัดสินใจว่าจะทำอะไร

ทำให้มันเล็ก(เช็กลิสต์สั้นหรือการเตือน)เพื่อหลีกเลี่ยงpromptบวม

ตัวอย่าง `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### เอเจนต์สามารถอัปเดต HEARTBEAT.md ได้หรือไม่

ได้ — หากคุณขอให้ทำ

`HEARTBEAT.md` เป็นเพียงไฟล์ปกติในเวิร์กสเปซของเอเจนต์ ดังนั้นคุณสามารถบอกเอเจนต์
(ในแชตปกติ) ประมาณว่า:

- “อัปเดต `HEARTBEAT.md` เพื่อเพิ่มการตรวจปฏิทินรายวัน”
- “เขียน `HEARTBEAT.md` ใหม่ให้สั้นลงและโฟกัสที่การติดตามกล่องจดหมาย”

หากต้องการให้เกิดขึ้นเชิงรุก คุณสามารถใส่บรรทัดชัดเจนในpromptของHeartbeat เช่น:
“หากเช็กลิสต์เริ่มล้าสมัย ให้อัปเดต HEARTBEAT.md ด้วยรายการที่ดีกว่า”

หมายเหตุด้านความปลอดภัย: อย่าใส่ความลับ(คีย์API หมายเลขโทรศัพท์ โทเคนส่วนตัว)
ลงใน `HEARTBEAT.md` — มันจะกลายเป็นส่วนหนึ่งของบริบทprompt

## ปลุกด้วยตนเอง(ตามต้องการ)

คุณสามารถเข้าคิวอีเวนต์ระบบและกระตุ้นHeartbeatทันทีด้วย:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

หากเอเจนต์หลายตัวมีการตั้งค่า `heartbeat` การปลุกด้วยตนเองจะรันHeartbeatของเอเจนต์เหล่านั้นทั้งหมดทันที

ใช้ `--mode next-heartbeat` เพื่อรอรอบถัดไปตามกำหนดเวลา

## การส่งเหตุผล(ไม่บังคับ)

ตามค่าเริ่มต้น Heartbeatจะส่งเฉพาะpayload “คำตอบ” สุดท้าย

หากต้องการความโปร่งใส ให้เปิด:

- `agents.defaults.heartbeat.includeReasoning: true`

When enabled, heartbeats will also deliver a separate message prefixed
`Reasoning:` (same shape as `/reasoning on`). This can be useful when the agent
is managing multiple sessions/codexes and you want to see why it decided to ping
you — but it can also leak more internal detail than you want. Prefer keeping it
off in group chats.

## การตระหนักถึงค่าใช้จ่าย

Heartbeats run full agent turns. Shorter intervals burn more tokens. Heartbeatรันagent turnsเต็มรูปแบบ ช่วงเวลาที่สั้นลงจะใช้โทเคนมากขึ้น
ทำให้ `HEARTBEAT.md` สั้น และพิจารณา `model` หรือ `target: "none"` ที่ถูกกว่า
หากคุณต้องการเพียงการอัปเดตสถานะภายในเท่านั้น
