---
summary: "พื้นผิวเครื่องมือของเอเจนต์สำหรับOpenClaw(เบราว์เซอร์,แคนวาส,โหนด,ข้อความ,cron)ที่มาแทนที่Skillsแบบดั้งเดิม`openclaw-*`"
read_when:
  - การเพิ่มหรือแก้ไขเครื่องมือของเอเจนต์
  - การยกเลิกหรือเปลี่ยนแปลงSkills`openclaw-*`
title: "เครื่องมือ"
---

# Tools (OpenClaw)

OpenClaw exposes **first-class agent tools** for browser, canvas, nodes, and cron.
OpenClaw เปิดเผย **เครื่องมือของเอเจนต์แบบชั้นหนึ่ง** สำหรับเบราว์เซอร์,แคนวาส,โหนดและcron
ซึ่งมาแทนที่Skills `openclaw-*` แบบเดิม: เครื่องมือมีชนิดข้อมูลชัดเจน,ไม่มีการเรียกเชลล์,
และเอเจนต์ควรพึ่งพาเครื่องมือเหล่านี้โดยตรง

## การปิดใช้งานเครื่องมือ

คุณสามารถอนุญาต/ปฏิเสธเครื่องมือแบบส่วนกลางได้ผ่าน `tools.allow` / `tools.deny` ใน `openclaw.json`
(การปฏิเสธมีผลเหนือกว่า) วิธีนี้ป้องกันไม่ให้ส่งเครื่องมือที่ไม่อนุญาตไปยังผู้ให้บริการโมเดล This prevents disallowed tools from being sent to model providers.

```json5
{
  tools: { deny: ["browser"] },
}
```

หมายเหตุ:

- Matching is case-insensitive.
- รองรับไวลด์การ์ด `*` (`"*"` หมายถึงเครื่องมือทั้งหมด)
- หาก `tools.allow` อ้างอิงเฉพาะชื่อเครื่องมือปลั๊กอินที่ไม่รู้จักหรือยังไม่โหลด OpenClaw จะบันทึกคำเตือนและเพิกเฉยต่อรายการอนุญาต เพื่อให้เครื่องมือแกนหลักยังคงใช้งานได้

## โปรไฟล์เครื่องมือ (รายการอนุญาตฐาน)

`tools.profile` ตั้งค่า **รายการอนุญาตเครื่องมือฐาน** ก่อน `tools.allow`/`tools.deny`  
การแทนที่ต่อเอเจนต์: `agents.list[].tools.profile`.
Per-agent override: `agents.list[].tools.profile`.

โปรไฟล์:

- `minimal`: `session_status` เท่านั้น
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: ไม่มีข้อจำกัด(เหมือนกับไม่ได้ตั้งค่า)

ตัวอย่าง(ค่าเริ่มต้นเฉพาะการส่งข้อความ และอนุญาตเครื่องมือ Slack + Discord เพิ่ม):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

ตัวอย่าง(โปรไฟล์การเขียนโค้ด แต่ปฏิเสธ exec/process ทุกที่):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

ตัวอย่าง(โปรไฟล์การเขียนโค้ดแบบส่วนกลาง เอเจนต์ซัพพอร์ตเฉพาะการส่งข้อความ):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## นโยบายเครื่องมือเฉพาะผู้ให้บริการ

ใช้ `tools.byProvider` เพื่อ **จำกัดเครื่องมือเพิ่มเติม** สำหรับผู้ให้บริการเฉพาะ
(หรือ `provider/model` เดียว) โดยไม่เปลี่ยนค่าเริ่มต้นแบบส่วนกลาง
การแทนที่ต่อเอเจนต์: `agents.list[].tools.byProvider`.
Per-agent override: `agents.list[].tools.byProvider`.

สิ่งนี้ถูกใช้ **หลัง** โปรไฟล์เครื่องมือฐาน และ **ก่อน** รายการอนุญาต/ปฏิเสธ
ดังนั้นจึงทำได้เพียงทำให้ชุดเครื่องมือแคบลง
คีย์ผู้ให้บริการยอมรับได้ทั้ง `provider` (เช่น `google-antigravity`) หรือ
`provider/model` (เช่น `openai/gpt-5.2`).
Provider keys accept either `provider` (e.g. `google-antigravity`) or
`provider/model` (e.g. `openai/gpt-5.2`).

ตัวอย่าง(คงโปรไฟล์การเขียนโค้ดแบบส่วนกลาง แต่ใช้เครื่องมือขั้นต่ำสำหรับ Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

ตัวอย่าง(รายการอนุญาตเฉพาะผู้ให้บริการ/โมเดลสำหรับเอ็นด์พอยต์ที่ไม่เสถียร):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

ตัวอย่าง(การแทนที่เฉพาะเอเจนต์สำหรับผู้ให้บริการเดียว):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## กลุ่มเครื่องมือ(ตัวย่อ)

นโยบายเครื่องมือ(ส่วนกลาง,เอเจนต์,sandbox)รองรับรายการ `group:*` ที่ขยายเป็นหลายเครื่องมือ
ใช้สิ่งเหล่านี้ใน `tools.allow` / `tools.deny`.
Use these in `tools.allow` / `tools.deny`.

กลุ่มที่มีให้:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: เครื่องมือ OpenClaw แบบบิลต์อินทั้งหมด(ไม่รวมปลั๊กอินผู้ให้บริการ)

ตัวอย่าง(อนุญาตเฉพาะเครื่องมือไฟล์ + เบราว์เซอร์):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## ปลั๊กอิน + เครื่องมือ

Plugins can register **additional tools** (and CLI commands) beyond the core set.
ปลั๊กอินสามารถลงทะเบียน **เครื่องมือเพิ่มเติม** (และคำสั่ง CLI) นอกเหนือจากชุดแกนหลักได้
ดู [Plugins](/tools/plugin) สำหรับการติดตั้ง+คอนฟิก และ [Skills](/tools/skills) สำหรับวิธีการแทรกแนวทางการใช้เครื่องมือเข้าไปในพรอมป์ต์ ปลั๊กอินบางตัวมาพร้อมSkillsของตนเองควบคู่กับเครื่องมือ(เช่นปลั๊กอินโทรด้วยเสียง) Some plugins ship their own skills
alongside tools (for example, the voice-call plugin).

เครื่องมือปลั๊กอินแบบไม่บังคับ:

- [Lobster](/tools/lobster): รันไทม์เวิร์กโฟลว์แบบมีชนิดข้อมูลพร้อมการอนุมัติที่ทำต่อได้(ต้องใช้ Lobster CLI บนโฮสต์Gateway)
- [LLM Task](/tools/llm-task): ขั้นตอน LLM แบบ JSON เท่านั้นสำหรับเอาต์พุตเวิร์กโฟลว์ที่มีโครงสร้าง(ตรวจสอบสคีมาได้แบบไม่บังคับ)

## รายการเครื่องมือ

### `apply_patch`

Apply structured patches across one or more files. Use for multi-hunk edits.
ใช้แพตช์แบบมีโครงสร้างกับไฟล์หนึ่งไฟล์หรือหลายไฟล์ เหมาะสำหรับการแก้ไขหลายฮังก์
ทดลองใช้: เปิดผ่าน `tools.exec.applyPatch.enabled`(เฉพาะโมเดล OpenAI)

### `exec`

รันคำสั่งเชลล์ในเวิร์กสเปซ

พารามิเตอร์หลัก:

- `command` (จำเป็น)
- `yieldMs` (ย้ายไปเบื้องหลังอัตโนมัติหลังหมดเวลา ค่าเริ่มต้น 10000)
- `background` (ย้ายไปเบื้องหลังทันที)
- `timeout` (วินาที; ฆ่าโปรเซสหากเกิน ค่าเริ่มต้น 1800)
- `elevated` (บูลีน; รันบนโฮสต์หากเปิด/อนุญาตโหมดยกระดับ; เปลี่ยนพฤติกรรมเฉพาะเมื่อเอเจนต์อยู่ในsandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/ชื่อโหนดสำหรับ `host=node`)
- ต้องการ TTY จริงหรือไม่? ตั้งค่า `pty: true`.

หมายเหตุ:

- คืนค่า `status: "running"` พร้อม `sessionId` เมื่อย้ายไปเบื้องหลัง
- ใช้ `process` เพื่อโพล/บันทึก/เขียน/ฆ่า/ล้างเซสชันเบื้องหลัง
- หาก `process` ถูกปฏิเสธ `exec` จะรันแบบซิงโครนัสและเพิกเฉยต่อ `yieldMs`/`background`
- `elevated` ถูกคุมด้วย `tools.elevated` รวมกับการแทนที่ `agents.list[].tools.elevated` ใดๆ(ทั้งสองต้องอนุญาต) และเป็นนามแฝงของ `host=gateway` + `security=full`
- `elevated` เปลี่ยนพฤติกรรมเฉพาะเมื่อเอเจนต์อยู่ในsandbox(อย่างอื่นไม่มีผล)
- `host=node` สามารถเล็งไปยังแอปคู่หู macOS หรือโฮสต์โหนดแบบไม่มีหัว(`openclaw node run`)
- การอนุมัติและรายการอนุญาตของgateway/โหนด: [Exec approvals](/tools/exec-approvals)

### `process`

จัดการเซสชัน exec เบื้องหลัง

การกระทำหลัก:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

หมายเหตุ:

- `poll` คืนเอาต์พุตใหม่และสถานะการออกเมื่อเสร็จสิ้น
- `log` รองรับ `offset`/`limit` แบบอิงบรรทัด(ละ `offset` เพื่อดึง N บรรทัดล่าสุด)
- `process` จำกัดขอบเขตต่อเอเจนต์; เซสชันจากเอเจนต์อื่นมองไม่เห็น

### `web_search`

ค้นหาเว็บด้วย Brave Search API

พารามิเตอร์หลัก:

- `query` (จำเป็น)
- `count` (1–10; ค่าเริ่มต้นจาก `tools.web.search.maxResults`)

หมายเหตุ:

- ต้องมีคีย์ Brave API(แนะนำ: `openclaw configure --section web` หรือกำหนด `BRAVE_API_KEY`)
- เปิดใช้งานผ่าน `tools.web.search.enabled`
- การตอบกลับถูกแคช(ค่าเริ่มต้น 15 นาที)
- ดู [Web tools](/tools/web) สำหรับการตั้งค่า

### `web_fetch`

ดึงและสกัดเนื้อหาที่อ่านได้จาก URL(HTML → markdown/text)

พารามิเตอร์หลัก:

- `url` (จำเป็น)
- `extractMode` (`markdown` | `text`)
- `maxChars` (ตัดหน้าที่ยาว)

หมายเหตุ:

- เปิดใช้งานผ่าน `tools.web.fetch.enabled`
- `maxChars` ถูกจำกัดด้วย `tools.web.fetch.maxCharsCap`(ค่าเริ่มต้น 50000)
- การตอบกลับถูกแคช(ค่าเริ่มต้น 15 นาที)
- สำหรับไซต์ที่ใช้ JS หนัก แนะนำใช้เครื่องมือเบราว์เซอร์
- ดู [Web tools](/tools/web) สำหรับการตั้งค่า
- ดู [Firecrawl](/tools/firecrawl) สำหรับทางเลือก anti-bot แบบไม่บังคับ

### `browser`

ควบคุมเบราว์เซอร์ที่ OpenClaw จัดการโดยเฉพาะ

การกระทำหลัก:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (คืนบล็อกภาพ + `MEDIA:<path>`)
- `act` (การกระทำ UI: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

การจัดการโปรไฟล์:

- `profiles` — แสดงรายการโปรไฟล์เบราว์เซอร์ทั้งหมดพร้อมสถานะ
- `create-profile` — สร้างโปรไฟล์ใหม่พร้อมพอร์ตที่จัดสรรอัตโนมัติ(หรือ `cdpUrl`)
- `delete-profile` — หยุดเบราว์เซอร์ ลบข้อมูลผู้ใช้ ลบออกจากคอนฟิก(เฉพาะโลคัล)
- `reset-profile` — ฆ่าโปรเซสที่หลงค้างบนพอร์ตของโปรไฟล์(เฉพาะโลคัล)

พารามิเตอร์ทั่วไป:

- `profile` (ไม่บังคับ; ค่าเริ่มต้น `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (ไม่บังคับ; เลือก id/ชื่อโหนดเฉพาะ)
  หมายเหตุ:
- ต้องการ `browser.enabled=true`(ค่าเริ่มต้นคือ `true`; ตั้ง `false` เพื่อปิด)
- ทุกการกระทำยอมรับพารามิเตอร์ `profile` แบบไม่บังคับสำหรับรองรับหลายอินสแตนซ์
- เมื่อไม่ระบุ `profile` จะใช้ `browser.defaultProfile`(ค่าเริ่มต้น "chrome")
- ชื่อโปรไฟล์: ตัวพิมพ์เล็กตัวอักษรและตัวเลข + ขีดกลางเท่านั้น(ยาวสุด 64 ตัวอักษร)
- ช่วงพอร์ต: 18800-18899(ประมาณ 100 โปรไฟล์)
- โปรไฟล์ระยะไกลเป็นแบบแนบเท่านั้น(ไม่เริ่ม/หยุด/รีเซ็ต)
- หากมีโหนดที่รองรับเบราว์เซอร์เชื่อมต่ออยู่ เครื่องมืออาจกำหนดเส้นทางอัตโนมัติไปยังโหนดนั้น(เว้นแต่คุณจะปักหมุด `target`)
- `snapshot` ค่าเริ่มต้นเป็น `ai` เมื่อมี Playwright ติดตั้ง; ใช้ `aria` สำหรับแผนผังการเข้าถึง
- `snapshot` รองรับตัวเลือก role-snapshot (`interactive`, `compact`, `depth`, `selector`) ซึ่งคืนค่าอ้างอิงเช่น `e12`
- `act` ต้องการ `ref` จาก `snapshot`(ค่าเชิงตัวเลข `12` จากสแนปช็อต AI หรือ `e12` จากสแนปช็อตบทบาท); ใช้ `evaluate` สำหรับกรณีต้องใช้ตัวเลือก CSS ที่พบไม่บ่อย
- หลีกเลี่ยง `act` → `wait` เป็นค่าเริ่มต้น; ใช้เฉพาะกรณีพิเศษ(ไม่มีสถานะ UI ที่เชื่อถือได้ให้รอ)
- `upload` สามารถส่ง `ref` เพื่อคลิกอัตโนมัติหลังเตรียมพร้อม
- `upload` รองรับ `inputRef`(aria ref) หรือ `element`(CSS selector) เพื่อกำหนด `<input type="file">` โดยตรง

### `canvas`

ขับเคลื่อน Canvas ของโหนด(present,eval,snapshot,A2UI)

การกระทำหลัก:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (คืนบล็อกภาพ + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

หมายเหตุ:

- ใช้ `node.invoke` ของGateway อยู่เบื้องหลัง
- หากไม่ระบุ `node` เครื่องมือจะเลือกค่าเริ่มต้น(โหนดที่เชื่อมต่อเพียงตัวเดียวหรือโหนด mac ในเครื่อง)
- A2UI รองรับเฉพาะ v0.8(ไม่มี `createSurface`); CLI จะปฏิเสธ JSONL v0.9 พร้อมข้อผิดพลาดรายบรรทัด
- ทดสอบเร็ว: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

ค้นหาและเล็งเป้าหมายโหนดที่จับคู่; ส่งการแจ้งเตือน; จับภาพกล้อง/หน้าจอ

การกระทำหลัก:

- `status`, `describe`
- `pending`, `approve`, `reject`(การจับคู่)
- `notify`(macOS `system.notify`)
- `run`(macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

หมายเหตุ:

- คำสั่งกล้อง/หน้าจอต้องให้แอปโหนดอยู่เบื้องหน้า
- ภาพจะคืนบล็อกภาพ + `MEDIA:<path>`
- วิดีโอคืนค่า `FILE:<path>`(mp4)
- ตำแหน่งที่ตั้งคืนเพย์โหลด JSON(lat/lon/accuracy/timestamp)
- พารามิเตอร์ `run`: อาร์เรย์ argv `command`; ไม่บังคับ `cwd`, `env`(`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

ตัวอย่าง(`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

วิเคราะห์ภาพด้วยโมเดลภาพที่ตั้งค่าไว้

พารามิเตอร์หลัก:

- `image` (พาธหรือ URL ที่จำเป็น)
- `prompt` (ไม่บังคับ; ค่าเริ่มต้น "Describe the image.")
- `model` (การแทนที่แบบไม่บังคับ)
- `maxBytesMb` (ขีดจำกัดขนาดแบบไม่บังคับ)

หมายเหตุ:

- ใช้ได้เฉพาะเมื่อมีการตั้งค่า `agents.defaults.imageModel`(ตัวหลักหรือสำรอง) หรือเมื่อสามารถอนุมานโมเดลภาพโดยปริยายจากโมเดลเริ่มต้นของคุณ + การยืนยันตัวตนที่ตั้งค่าไว้(พยายามจับคู่ให้ดีที่สุด)
- ใช้โมเดลภาพโดยตรง(แยกจากโมเดลแชตหลัก)

### `message`

ส่งข้อความและการกระทำของช่องทางข้าม Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams

การกระทำหลัก:

- `send` (ข้อความ + สื่อเสริม; MS Teams รองรับ `card` สำหรับ Adaptive Cards)
- `poll` (โพล WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

หมายเหตุ:

- `send` ส่ง WhatsApp ผ่านGateway; ช่องทางอื่นส่งตรง
- `poll` ใช้Gatewayสำหรับ WhatsApp และ MS Teams; โพลของ Discord ส่งตรง
- เมื่อการเรียกเครื่องมือส่งข้อความถูกผูกกับเซสชันแชตที่ใช้งานอยู่ การส่งจะถูกจำกัดไปยังเป้าหมายของเซสชันนั้นเพื่อหลีกเลี่ยงการรั่วไหลข้ามบริบท

### `cron`

จัดการงาน cron และการปลุกของGateway

การกระทำหลัก:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (เข้าคิวอีเวนต์ระบบ + ฮาร์ตบีตทันทีแบบไม่บังคับ)

หมายเหตุ:

- `add` คาดหวังอ็อบเจ็กต์งาน cron แบบเต็ม(สคีมาเดียวกับ `cron.add` RPC)
- `update` ใช้ `{ jobId, patch }`(รองรับ `id` เพื่อความเข้ากันได้)

### `gateway`

รีสตาร์ตหรือปรับใช้การอัปเดตกับโปรเซสGatewayที่กำลังรันอยู่(ในที่เดิม)

การกระทำหลัก:

- `restart` (อนุญาต + ส่ง `SIGUSR1` เพื่อรีสตาร์ตในโปรเซส; `openclaw gateway` รีสตาร์ตในที่เดิม)
- `config.get` / `config.schema`
- `config.apply` (ตรวจสอบ + เขียนคอนฟิก + รีสตาร์ต + ปลุก)
- `config.patch` (รวมการอัปเดตบางส่วน + รีสตาร์ต + ปลุก)
- `update.run` (รันอัปเดต + รีสตาร์ต + ปลุก)

หมายเหตุ:

- ใช้ `delayMs`(ค่าเริ่มต้น 2000) เพื่อหลีกเลี่ยงการขัดจังหวะการตอบกลับที่กำลังดำเนินอยู่
- `restart` ปิดใช้งานเป็นค่าเริ่มต้น; เปิดด้วย `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

แสดงรายการเซสชัน ตรวจสอบประวัติทรานสคริปต์ หรือส่งไปยังอีกเซสชันหนึ่ง

พารามิเตอร์หลัก:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?`(0 = ไม่มี)
- `sessions_history`: `sessionKey`(หรือ `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey`(หรือ `sessionId`), `message`, `timeoutSeconds?`(0 = ส่งแล้วไม่รอ)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?`(ค่าเริ่มต้นปัจจุบัน; รองรับ `sessionId`), `model?`(`default` ล้างการแทนที่)

หมายเหตุ:

- `main` คือคีย์แชตตรงตามมาตรฐาน; แบบส่วนกลาง/ไม่รู้จักจะถูกซ่อน
- `messageLimit > 0` ดึงข้อความ N ล่าสุดต่อเซสชัน(กรองข้อความเครื่องมือ)
- `sessions_send` จะรอการเสร็จสิ้นขั้นสุดท้ายเมื่อ `timeoutSeconds > 0`
- การส่งมอบ/ประกาศเกิดหลังเสร็จสิ้นและเป็นแบบพยายามให้ดีที่สุด; `status: "ok"` ยืนยันว่าการรันเอเจนต์เสร็จ ไม่ได้ยืนยันว่าการประกาศถูกส่งแล้ว
- `sessions_spawn` เริ่มการรันซับเอเจนต์และโพสต์คำตอบประกาศกลับไปยังแชตผู้ร้องขอ
- `sessions_spawn` ไม่บล็อกและคืนค่า `status: "accepted"` ทันที
- `sessions_send` รัน ping‑pong ตอบกลับ(ตอบ `REPLY_SKIP` เพื่อหยุด; จำนวนรอบสูงสุดผ่าน `session.agentToAgent.maxPingPongTurns`, 0–5)
- หลัง ping‑pong เอเจนต์เป้าหมายจะรัน **ขั้นประกาศ**; ตอบ `ANNOUNCE_SKIP` เพื่อระงับการประกาศ

### `agents_list`

แสดงรายการ id เอเจนต์ที่เซสชันปัจจุบันสามารถเล็งเป้าหมายด้วย `sessions_spawn`.

หมายเหตุ:

- ผลลัพธ์ถูกจำกัดตามรายการอนุญาตต่อเอเจนต์(`agents.list[].subagents.allowAgents`)
- เมื่อมีการตั้งค่า `["*"]` เครื่องมือจะรวมเอเจนต์ที่ตั้งค่าทั้งหมดและทำเครื่องหมาย `allowAny: true`.

## พารามิเตอร์(ทั่วไป)

เครื่องมือที่พึ่งพาGateway(`canvas`, `nodes`, `cron`):

- `gatewayUrl`(ค่าเริ่มต้น `ws://127.0.0.1:18789`)
- `gatewayToken`(หากเปิดการยืนยันตัวตน)
- `timeoutMs`

Note: when `gatewayUrl` is set, include `gatewayToken` explicitly. หมายเหตุ: เมื่อมีการตั้งค่า `gatewayUrl` ให้ใส่ `gatewayToken` อย่างชัดเจน เครื่องมือจะไม่สืบทอดคอนฟิก
หรือข้อมูลรับรองจากสภาพแวดล้อมสำหรับการแทนที่ และหากไม่มีข้อมูลรับรองที่ระบุอย่างชัดเจนจะถือเป็นข้อผิดพลาด

เครื่องมือเบราว์เซอร์:

- `profile`(ไม่บังคับ; ค่าเริ่มต้น `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node`(ไม่บังคับ; ปักหมุด id/ชื่อโหนดเฉพาะ)

## โฟลว์เอเจนต์ที่แนะนำ

การทำงานอัตโนมัติด้วยเบราว์เซอร์:

1. `browser` → `status` / `start`
2. `snapshot`(ai หรือ aria)
3. `act`(click/type/press)
4. `screenshot` หากต้องการยืนยันด้วยภาพ

Canvas render:

1. `canvas` → `present`
2. `a2ui_push`(ไม่บังคับ)
3. `snapshot`

การเล็งเป้าหมายโหนด:

1. `nodes` → `status`
2. `describe` บนโหนดที่เลือก
3. `notify` / `run` / `camera_snap` / `screen_record`

## ความปลอดภัย

- หลีกเลี่ยง `system.run` โดยตรง; ใช้ `nodes` → `run` เฉพาะเมื่อมีความยินยอมจากผู้ใช้อย่างชัดเจน
- เคารพความยินยอมของผู้ใช้สำหรับการจับภาพกล้อง/หน้าจอ
- ใช้ `status/describe` เพื่อให้แน่ใจว่ามีสิทธิ์ก่อนเรียกคำสั่งสื่อ

## วิธีที่เครื่องมือถูกนำเสนอให้เอเจนต์

เครื่องมือถูกเปิดเผยในสองช่องทางคู่ขนาน:

1. **ข้อความใน system prompt**: รายการที่มนุษย์อ่านได้ + แนวทาง
2. **สคีมาเครื่องมือ**: นิยามฟังก์ชันแบบมีโครงสร้างที่ส่งไปยัง API ของโมเดล

That means the agent sees both “what tools exist” and “how to call them.” นั่นหมายความว่าเอเจนต์จะเห็นทั้ง“มีเครื่องมืออะไรบ้าง”และ“เรียกใช้อย่างไร” หากเครื่องมือ
ไม่ปรากฏใน system prompt หรือในสคีมา โมเดลจะไม่สามารถเรียกใช้ได้
