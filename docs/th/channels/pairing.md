---
summary: "ภาพรวมการจับคู่: อนุมัติว่าใครสามารถส่งDMถึงคุณได้ + โหนดใดบ้างที่สามารถเข้าร่วมได้"
read_when:
  - การตั้งค่าการควบคุมการเข้าถึงDM
  - การจับคู่โหนด iOS/Android ใหม่
  - การทบทวนท่าทีด้านความปลอดภัยของ OpenClaw
title: "การจับคู่"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:50Z
---

# การจับคู่

“การจับคู่” คือขั้นตอนการ **อนุมัติโดยเจ้าของ** อย่างชัดเจนของ OpenClaw
ใช้ในสองกรณี:

1. **การจับคู่DM** (ใครบ้างที่ได้รับอนุญาตให้คุยกับบอต)
2. **การจับคู่โหนด** (อุปกรณ์/โหนดใดบ้างที่ได้รับอนุญาตให้เข้าร่วมเครือข่าย Gateway)

บริบทด้านความปลอดภัย: [Security](/gateway/security)

## 1) การจับคู่DM (การเข้าถึงแชทขาเข้า)

เมื่อกำหนดค่า channel ด้วยนโยบายDM `pairing` ผู้ส่งที่ไม่รู้จักจะได้รับรหัสสั้น และข้อความของพวกเขา **จะไม่ถูกประมวลผล** จนกว่าคุณจะอนุมัติ

นโยบายDMค่าเริ่มต้นมีเอกสารไว้ที่: [Security](/gateway/security)

รหัสการจับคู่:

- ความยาว 8 ตัวอักษร ตัวพิมพ์ใหญ่ ไม่มีอักขระที่คลุมเครือ (`0O1I`).
- **หมดอายุภายใน 1 ชั่วโมง** บอตจะส่งข้อความการจับคู่เฉพาะเมื่อมีการสร้างคำขอใหม่ (ประมาณหนึ่งครั้งต่อชั่วโมงต่อผู้ส่ง)
- คำขอจับคู่DMที่รอดำเนินการถูกจำกัดที่ **3 รายการต่อ channel** โดยค่าเริ่มต้น คำขอเพิ่มเติมจะถูกเพิกเฉยจนกว่าจะมีรายการหนึ่งหมดอายุหรือได้รับการอนุมัติ

### อนุมัติผู้ส่ง

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

ช่องทางที่รองรับ: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### ที่เก็บสถานะ

จัดเก็บภายใต้ `~/.openclaw/credentials/`:

- คำขอที่รอดำเนินการ: `<channel>-pairing.json`
- ที่เก็บรายการอนุญาตที่ได้รับการอนุมัติ: `<channel>-allowFrom.json`

ควรปฏิบัติต่อข้อมูลเหล่านี้เป็นข้อมูลอ่อนไหว(เป็นตัวควบคุมการเข้าถึงผู้ช่วยของคุณ)

## 2) การจับคู่อุปกรณ์โหนด (iOS/Android/macOS/โหนดแบบไม่แสดงผล)

โหนดจะเชื่อมต่อกับ Gateway ในฐานะ **อุปกรณ์** ด้วย `role: node` Gateway
จะสร้างคำขอจับคู่อุปกรณ์ซึ่งต้องได้รับการอนุมัติ

### อนุมัติอุปกรณ์โหนด

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### ที่จัดเก็บสถานะการจับคู่โหนด

จัดเก็บภายใต้ `~/.openclaw/devices/`:

- `pending.json` (อายุสั้น; คำขอที่รอดำเนินการจะหมดอายุ)
- `paired.json` (อุปกรณ์ที่จับคู่แล้ว + โทเคน)

### หมายเหตุ

- API แบบเดิม `node.pair.*` (CLI: `openclaw nodes pending/approve`) เป็นที่เก็บการจับคู่ที่ Gateway เป็นเจ้าของแยกต่างหาก โหนดแบบWSยังคงต้องใช้การจับคู่อุปกรณ์

## เอกสารที่เกี่ยวข้อง

- โมเดลความปลอดภัย + prompt injection: [Security](/gateway/security)
- การอัปเดตอย่างปลอดภัย(run doctor): [Updating](/install/updating)
- คอนฟิกของ channel:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
