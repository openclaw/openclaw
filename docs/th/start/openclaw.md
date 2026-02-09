---
summary: "คู่มือแบบครบวงจรสำหรับการรัน OpenClaw เป็นผู้ช่วยส่วนตัวพร้อมข้อควรระวังด้านความปลอดภัย"
read_when:
  - การเริ่มต้นใช้งานอินสแตนซ์ผู้ช่วยใหม่
  - การทบทวนผลกระทบด้านความปลอดภัย/สิทธิ์
title: "การตั้งค่าผู้ช่วยส่วนตัว"
---

# การสร้างผู้ช่วยส่วนตัวด้วย OpenClaw

OpenClaw คือ Gateway（เกตเวย์）ของ WhatsApp + Telegram + Discord + iMessage สำหรับเอเจนต์ **Pi** ปลั๊กอินสามารถเพิ่ม Mattermost ได้ คู่มือนี้คือการตั้งค่าแบบ "ผู้ช่วยส่วนตัว": ใช้หมายเลข WhatsApp เฉพาะหนึ่งหมายเลขที่ทำงานเหมือนเอเจนต์ที่พร้อมใช้งานตลอดเวลา ปลั๊กอินเพิ่ม Mattermost คู่มือนี้เป็นการตั้งค่าแบบ "ผู้ช่วยส่วนตัว": หมายเลข WhatsApp เฉพาะหนึ่งหมายเลขที่ทำงานเหมือนเอเจนต์ที่เปิดใช้งานตลอดเวลา

## ⚠️ ความปลอดภัยมาก่อน

คุณกำลังวางเอเจนต์ไว้ในตำแหน่งที่สามารถ:

- รันคำสั่งบนเครื่องของคุณได้(ขึ้นกับการตั้งค่าเครื่องมือ Pi)
- อ่าน/เขียนไฟล์ในเวิร์กสเปซของคุณ
- ส่งข้อความออกผ่าน WhatsApp/Telegram/Discord/Mattermost(ปลั๊กอิน)

เริ่มอย่างระมัดระวัง:

- ตั้งค่า `channels.whatsapp.allowFrom` เสมอ(อย่ารันแบบเปิดสู่สาธารณะบน Mac ส่วนตัวของคุณ)
- ใช้หมายเลข WhatsApp เฉพาะสำหรับผู้ช่วย
- ขณะนี้ heartbeat ตั้งค่าเริ่มต้นเป็นทุก ๆ 30 นาที ฮาร์ตบีตตั้งค่าเริ่มต้นทุก 30 นาที ปิดไว้ก่อนจนกว่าจะเชื่อมั่นในการตั้งค่าโดยตั้งค่า `agents.defaults.heartbeat.every: "0m"`

## ข้อกำหนดก่อนเริ่มต้น

- ติดตั้งและออนบอร์ด OpenClaw แล้ว—ดู [เริ่มต้นใช้งาน](/start/getting-started) หากยังไม่ได้ทำ
- หมายเลขโทรศัพท์ที่สอง(SIM/eSIM/เติมเงิน)สำหรับผู้ช่วย

## การตั้งค่าแบบสองโทรศัพท์(แนะนำ)

สิ่งที่คุณต้องการคือ:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

หากคุณเชื่อม WhatsApp ส่วนตัวเข้ากับ OpenClaw ทุกข้อความที่ส่งถึงคุณจะกลายเป็น “อินพุตของเอเจนต์” ซึ่งแทบไม่ใช่สิ่งที่ต้องการ ซึ่งนั่นแทบจะไม่ใช่สิ่งที่คุณต้องการ

## เริ่มต้นอย่างรวดเร็วภายใน 5 นาที

1. จับคู่ WhatsApp Web(แสดง QR; สแกนด้วยโทรศัพท์ของผู้ช่วย):

```bash
openclaw channels login
```

2. เริ่ม Gateway(ปล่อยให้รันต่อเนื่อง):

```bash
openclaw gateway --port 18789
```

3. ใส่คอนฟิกขั้นต่ำใน `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

จากนั้นส่งข้อความไปยังหมายเลขผู้ช่วยจากโทรศัพท์ที่อยู่ใน allowlist ของคุณ

เมื่อการเริ่มต้นใช้งานเสร็จสิ้น เราจะเปิดแดชบอร์ดอัตโนมัติและพิมพ์ลิงก์ที่สะอาด (ไม่มี token) เมื่อการออนบอร์ดเสร็จ เราจะเปิดแดชบอร์ดอัตโนมัติและพิมพ์ลิงก์แบบสะอาด(ไม่ฝังโทเคน) หากมีการขอการยืนยันตัวตน ให้วางโทเคนจาก `gateway.auth.token` ลงใน Control UI settings หากต้องการเปิดอีกครั้งภายหลัง: `openclaw dashboard`. หากต้องการเปิดใหม่ภายหลัง: `openclaw dashboard`

## ให้เวิร์กสเปซแก่เอเจนต์(AGENTS)

OpenClaw อ่านคำสั่งการทำงานและ “ความจำ” จากไดเรกทอรีเวิร์กสเปซของมัน

โดยค่าเริ่มต้น OpenClaw ใช้ `~/.openclaw/workspace` เป็นเวิร์กสเปซของเอเจนต์ และจะสร้างมัน(พร้อมไฟล์เริ่มต้น `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) อัตโนมัติในขั้นตอนการตั้งค่าหรือการรันเอเจนต์ครั้งแรก `BOOTSTRAP.md` จะถูกสร้างเฉพาะเมื่อเวิร์กสเปซเป็นของใหม่จริงๆ(ไม่ควรถูกสร้างกลับมาอีกหลังจากคุณลบมัน) `MEMORY.md` เป็นตัวเลือกเสริม(ไม่ถูกสร้างอัตโนมัติ); เมื่อมีอยู่ จะถูกโหลดสำหรับเซสชันปกติ เซสชันของซับเอเจนต์จะฉีดเฉพาะ `AGENTS.md` และ `TOOLS.md` เท่านั้น `BOOTSTRAP.md` จะถูกสร้างขึ้นเฉพาะเมื่อ workspace เป็นของใหม่เอี่ยมเท่านั้น (ไม่ควรกลับมาอีกหลังจากที่คุณลบไปแล้ว) `MEMORY.md` เป็นตัวเลือก (ไม่ถูกสร้างอัตโนมัติ); เมื่อมีอยู่ จะถูกโหลดสำหรับเซสชันปกติ เซสชันของ subagent จะ inject เฉพาะ `AGENTS.md` และ `TOOLS.md` เท่านั้น

เคล็ดลับ: ปฏิบัติต่อโฟลเดอร์นี้เหมือน “ความจำ” ของ OpenClaw และทำให้เป็น git repo(ควรเป็นแบบส่วนตัว) เพื่อให้ไฟล์ `AGENTS.md` + ไฟล์ความจำได้รับการสำรอง หากติดตั้ง git แล้ว เวิร์กสเปซใหม่เอี่ยมจะถูกตั้งค่าเริ่มต้นอัตโนมัติ หากติดตั้ง git ไว้แล้ว workspace ใหม่เอี่ยมจะถูกตั้งค่าเริ่มต้นให้อัตโนมัติ

```bash
openclaw setup
```

โครงสร้างเวิร์กสเปซเต็มรูปแบบ + คู่มือสำรองข้อมูล: [Agent workspace](/concepts/agent-workspace)
เวิร์กโฟลว์ความจำ: [Memory](/concepts/memory)

ตัวเลือกเสริม: เลือกเวิร์กสเปซอื่นด้วย `agents.defaults.workspace`(รองรับ `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

หากคุณมีไฟล์เวิร์กสเปซของตัวเองจาก repo อยู่แล้ว คุณสามารถปิดการสร้างไฟล์เริ่มต้นทั้งหมดได้:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## คอนฟิกที่ทำให้มันเป็น “ผู้ช่วย”

ค่าเริ่มต้นของ OpenClaw เป็นการตั้งค่าผู้ช่วยที่ดีอยู่แล้ว แต่โดยทั่วไปคุณจะต้องปรับ:

- persona/คำสั่งใน `SOUL.md`
- ค่าเริ่มต้นด้านการคิด(หากต้องการ)
- ฮาร์ตบีต(เมื่อคุณเชื่อถือได้แล้ว)

ตัวอย่าง:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## เซสชันและความจำ

- ไฟล์เซสชัน: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- เมทาดาทาของเซสชัน(การใช้โทเคน เส้นทางล่าสุด ฯลฯ): `~/.openclaw/agents/<agentId>/sessions/sessions.json`(เดิม: `~/.openclaw/sessions/sessions.json`)
- `/new` หรือ `/reset` จะเริ่มเซสชันใหม่สำหรับแชตนั้น(กำหนดค่าได้ผ่าน `resetTriggers`). หากส่งเพียงอย่างเดียว เอเจนต์จะตอบทักทายสั้นๆเพื่อยืนยันการรีเซ็ต
- `/compact [instructions]` จะย่อบริบทของเซสชันและรายงานงบประมาณบริบทที่เหลือ

## ฮาร์ตบีต(โหมดเชิงรุก)

โดยค่าเริ่มต้น OpenClaw จะรันฮาร์ตบีตทุก 30 นาทีด้วยพรอมป์ต์:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
ตั้งค่า `agents.defaults.heartbeat.every: "0m"` เพื่อปิดใช้งาน

- หาก `HEARTBEAT.md` มีอยู่แต่แทบว่างเปล่า(มีเพียงบรรทัดว่างและหัวข้อมาร์กดาวน์เช่น `# Heading`), OpenClaw จะข้ามการรันฮาร์ตบีตเพื่อประหยัดการเรียก API
- หากไฟล์หายไป ฮาร์ตบีตยังคงรันและโมเดลจะตัดสินใจว่าจะทำอะไร
- หากเอเจนต์ตอบด้วย `HEARTBEAT_OK`(อาจมีข้อความเติมสั้นๆ; ดู `agents.defaults.heartbeat.ackMaxChars`), OpenClaw จะระงับการส่งออกสำหรับฮาร์ตบีตนั้น
- ฮาร์ตบีตรันเป็นเทิร์นของเอเจนต์แบบเต็ม—ช่วงเวลาที่สั้นลงจะใช้โทเคนมากขึ้น

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## สื่อเข้าและออก

ไฟล์แนบขาเข้า(ภาพ/เสียง/เอกสาร)สามารถถูกส่งต่อให้คำสั่งของคุณผ่านเทมเพลต:

- `{{MediaPath}}`(พาธไฟล์ชั่วคราวในเครื่อง)
- `{{MediaUrl}}`(pseudo-URL)
- `{{Transcript}}`(หากเปิดใช้งานการถอดเสียง)

ไฟล์แนบขาออกจากเอเจนต์: ใส่ `MEDIA:<path-or-url>` ไว้ในบรรทัดของมันเอง(ไม่มีเว้นวรรค) ตัวอย่าง: ตัวอย่าง:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw จะดึงสิ่งเหล่านี้ออกมาและส่งเป็นสื่อควบคู่ไปกับข้อความ

## เช็กลิสต์การปฏิบัติการ

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

บันทึกล็อกอยู่ที่ `/tmp/openclaw/`(ค่าเริ่มต้น: `openclaw-YYYY-MM-DD.log`).

## ขั้นตอนถัดไป

- WebChat: [WebChat](/web/webchat)
- การปฏิบัติการ Gateway: [Gateway runbook](/gateway)
- Cron + การปลุก: [Cron jobs](/automation/cron-jobs)
- แอปคู่หูแถบเมนู macOS: [OpenClaw macOS app](/platforms/macos)
- แอปโหนด iOS: [iOS app](/platforms/ios)
- แอปโหนด Android: [Android app](/platforms/android)
- สถานะ Windows: [Windows (WSL2)](/platforms/windows)
- สถานะ Linux: [Linux app](/platforms/linux)
- ความปลอดภัย: [Security](/gateway/security)
