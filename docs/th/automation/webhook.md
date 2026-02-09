---
summary: "Webhook สำหรับรับเข้าการปลุกและการรันเอเจนต์แบบแยก"
read_when:
  - การเพิ่มหรือเปลี่ยนแปลงเอ็นด์พอยต์ webhook
  - การเชื่อมต่อระบบภายนอกเข้ากับ OpenClaw
title: "Webhooks"
---

# Webhooks

Gateway สามารถเปิดเอ็นด์พอยต์ HTTP webhook ขนาดเล็กสำหรับทริกเกอร์จากภายนอกได้

## Enable

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Notes:

- ต้องใช้ `hooks.token` เมื่อ `hooks.enabled=true`
- `hooks.path` ใช้ค่าเริ่มต้นเป็น `/hooks`

## Auth

ทุกคำขอต้องมี hook token แนะนำให้ส่งผ่านเฮดเดอร์: 4. ให้ความสำคัญกับเฮดเดอร์:

- `Authorization: Bearer <token>` (แนะนำ)
- `x-openclaw-token: <token>`
- `?token=<token>` (เลิกใช้แล้ว; จะบันทึกคำเตือนในล็อกและจะถูกลบออกในรีลีสหลักในอนาคต)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **จำเป็น** (string): คำอธิบายของเหตุการณ์ (เช่น "New email received")
- `mode` ไม่บังคับ (`now` | `next-heartbeat`): ระบุว่าจะทริกเกอร์ heartbeat ทันทีหรือรอการตรวจสอบตามรอบถัดไป (ค่าเริ่มต้น `now`)

Effect:

- เข้าคิวเหตุการณ์ระบบสำหรับเซสชัน **หลัก**
- หาก `mode=now` จะทริกเกอร์ heartbeat ทันที

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **จำเป็น** (string): พรอมป์ต์หรือข้อความที่ให้เอเจนต์ประมวลผล
- `name` ไม่บังคับ (string): ชื่อที่อ่านเข้าใจง่ายสำหรับ hook (เช่น "GitHub") ใช้เป็นคำนำหน้าในสรุปเซสชัน
- `sessionKey` ไม่บังคับ (string): คีย์ที่ใช้ระบุเซสชันของเอเจนต์ ค่าเริ่มต้นเป็น `hook:<uuid>` แบบสุ่ม การใช้คีย์ที่สม่ำเสมอช่วยให้สนทนาได้หลายเทิร์นภายในบริบทของ hook 5. ค่าเริ่มต้นเป็น `hook:<uuid>` แบบสุ่ม 6. การใช้คีย์ที่สอดคล้องกันช่วยให้สามารถสนทนาแบบหลายรอบภายในบริบทของ hook เดียวกันได้
- `wakeMode` ไม่บังคับ (`now` | `next-heartbeat`): ระบุว่าจะทริกเกอร์ heartbeat ทันทีหรือรอการตรวจสอบตามรอบถัดไป (ค่าเริ่มต้น `now`)
- `deliver` ไม่บังคับ (boolean): หาก `true` การตอบกลับของเอเจนต์จะถูกส่งไปยังช่องทางข้อความ ค่าเริ่มต้นเป็น `true` การตอบกลับที่เป็นเพียงการยืนยัน heartbeat จะถูกข้ามโดยอัตโนมัติ 7. ค่าเริ่มต้นเป็น `true` 8. การตอบกลับที่เป็นเพียงการยืนยัน heartbeat เท่านั้นจะถูกข้ามโดยอัตโนมัติ
- `channel` optional (string): The messaging channel for delivery. `channel` ไม่บังคับ (string): ช่องทางข้อความสำหรับการส่ง หนึ่งใน: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams` ค่าเริ่มต้นเป็น `last` 10. ค่าเริ่มต้นเป็น `last`
- `to` ไม่บังคับ (string): ตัวระบุผู้รับสำหรับช่องทาง (เช่น หมายเลขโทรศัพท์สำหรับ WhatsApp/Signal, chat ID สำหรับ Telegram, channel ID สำหรับ Discord/Slack/Mattermost (plugin), conversation ID สำหรับ Microsoft Teams) ค่าเริ่มต้นเป็นผู้รับล่าสุดในเซสชันหลัก 11. ค่าเริ่มต้นเป็นผู้รับรายล่าสุดในเซสชันหลัก
- `model` ไม่บังคับ (string): การแทนที่โมเดล (เช่น `anthropic/claude-3-5-sonnet` หรือชื่อแฝง) ต้องอยู่ในรายการโมเดลที่อนุญาตหากมีการจำกัด Must be in the allowed model list if restricted.
- `thinking` ไม่บังคับ (string): การแทนที่ระดับการคิด (เช่น `low`, `medium`, `high`)
- `timeoutSeconds` ไม่บังคับ (number): ระยะเวลาสูงสุดสำหรับการรันเอเจนต์เป็นวินาที

Effect:

- รันเอเจนต์แบบ **แยก** (ใช้คีย์เซสชันของตนเอง)
- โพสต์สรุปไปยังเซสชัน **หลัก** เสมอ
- หาก `wakeMode=now` จะทริกเกอร์ heartbeat ทันที

### `POST /hooks/<name>` (mapped)

Custom hook names are resolved via `hooks.mappings` (see configuration). ชื่อ hook แบบกำหนดเองจะถูกแก้ไขผ่าน `hooks.mappings` (ดูการกำหนดค่า) การแมปสามารถ
แปลง payload ใดๆ ให้เป็นการกระทำ `wake` หรือ `agent` พร้อมเทมเพลตหรือ
การแปลงโค้ดตามต้องการ

ตัวเลือกการแมป (สรุป):

- `hooks.presets: ["gmail"]` เปิดใช้การแมป Gmail ที่มีมาให้
- `hooks.mappings` ให้คุณกำหนด `match`, `action` และเทมเพลตในคอนฟิก
- `hooks.transformsDir` + `transform.module` โหลดโมดูล JS/TS สำหรับลอจิกแบบกำหนดเอง
- ใช้ `match.source` เพื่อคงเอ็นด์พอยต์รับเข้าทั่วไป (การกำหนดเส้นทางตาม payload)
- การแปลง TS ต้องใช้ตัวโหลด TS (เช่น `bun` หรือ `tsx`) หรือ `.js` ที่คอมไพล์ล่วงหน้าในขณะรันไทม์
- ตั้งค่า `deliver: true` + `channel`/`to` บนการแมปเพื่อกำหนดเส้นทางการตอบกลับไปยังพื้นผิวแชต
  (`channel` ใช้ค่าเริ่มต้นเป็น `last` และจะถอยกลับไปใช้ WhatsApp)
- `allowUnsafeExternalContent: true` ปิดตัวห่อความปลอดภัยของเนื้อหาภายนอกสำหรับ hook นั้น
  (อันตราย; ใช้เฉพาะแหล่งภายในที่เชื่อถือได้)
- `openclaw webhooks gmail setup` เขียนคอนฟิก `hooks.gmail` สำหรับ `openclaw webhooks gmail run`
  ดู [Gmail Pub/Sub](/automation/gmail-pubsub) สำหรับโฟลว์การเฝ้าดู Gmail แบบครบถ้วน
  14. ดู [Gmail Pub/Sub](/automation/gmail-pubsub) สำหรับขั้นตอนการ watch ของ Gmail แบบครบถ้วน

## Responses

- `200` สำหรับ `/hooks/wake`
- `202` สำหรับ `/hooks/agent` (เริ่มการรันแบบ async แล้ว)
- `401` เมื่อการยืนยันตัวตนล้มเหลว
- `400` เมื่อ payload ไม่ถูกต้อง
- `413` เมื่อ payload มีขนาดใหญ่เกินไป

## Examples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Use a different model

เพิ่ม `model` ลงใน payload ของเอเจนต์ (หรือในการแมป) เพื่อแทนที่โมเดลสำหรับการรันนั้น:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

หากคุณบังคับใช้ `agents.defaults.models` โปรดตรวจสอบให้แน่ใจว่าโมเดลที่แทนที่ถูกรวมอยู่ในรายการดังกล่าว

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- เก็บเอ็นด์พอยต์ hook ไว้หลัง loopback, tailnet หรือรีเวิร์สพร็อกซีที่เชื่อถือได้
- ใช้ hook token เฉพาะ ห้ามนำโทเคนยืนยันตัวตนของ Gateway มาใช้ซ้ำ
- หลีกเลี่ยงการใส่ payload ดิบที่มีข้อมูลอ่อนไหวในล็อกของ webhook
- 15. payload ของ hook จะถูกมองว่าไม่น่าเชื่อถือ และถูกห่อด้วยขอบเขตความปลอดภัยตามค่าเริ่มต้น
      payload ของ hook จะถูกมองว่าไม่น่าเชื่อถือและถูกห่อด้วยขอบเขตความปลอดภัยตามค่าเริ่มต้น
      หากจำเป็นต้องปิดสำหรับ hook เฉพาะ ให้ตั้งค่า `allowUnsafeExternalContent: true`
      ในการแมปของ hook นั้น (อันตราย)
