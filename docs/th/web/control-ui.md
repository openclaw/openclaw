---
summary: "UIควบคุมผ่านเบราว์เซอร์สำหรับGateway(แชท,โหนด,คอนฟิก)"
read_when:
  - คุณต้องการใช้งานGatewayจากเบราว์เซอร์
  - คุณต้องการเข้าถึงผ่านTailnetโดยไม่ใช้อุโมงค์SSH
title: "Control UI"
---

# Control UI (เบราว์เซอร์)

Control UI เป็นแอปหน้าเดียวขนาดเล็ก **Vite + Lit** ที่ให้บริการโดยGateway:

- ค่าเริ่มต้น: `http://<host>:18789/`
- คำนำหน้าเสริม: ตั้งค่า `gateway.controlUi.basePath` (เช่น `/openclaw`)

สื่อสาร **โดยตรงกับ Gateway WebSocket** บนพอร์ตเดียวกัน

## เปิดอย่างรวดเร็ว (ภายในเครื่อง)

หากGatewayทำงานอยู่บนคอมพิวเตอร์เครื่องเดียวกัน ให้เปิด:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (หรือ [http://localhost:18789/](http://localhost:18789/))

หากหน้าไม่โหลด ให้เริ่มGatewayก่อน: `openclaw gateway`.

การยืนยันตัวตนจะถูกส่งระหว่างการทำ WebSocket handshake ผ่าน:

- `connect.params.auth.token`
- `connect.params.auth.password`
  แผงการตั้งค่าแดชบอร์ดช่วยให้คุณบันทึกโทเคนได้; รหัสผ่านจะไม่ถูกเก็บถาวร
  วิซาร์ดเริ่มต้นจะสร้างโทเคนของGatewayเป็นค่าเริ่มต้น ดังนั้นให้วางที่นี่เมื่อเชื่อมต่อครั้งแรก
  ตัวช่วยเริ่มต้นจะสร้างโทเค็นของเกตเวย์ให้โดยค่าเริ่มต้น ดังนั้นให้วางที่นี่เมื่อเชื่อมต่อครั้งแรก

## การจับคู่อุปกรณ์ (การเชื่อมต่อครั้งแรก)

เมื่อคุณเชื่อมต่อ Control UI จากเบราว์เซอร์หรืออุปกรณ์ใหม่ Gateway
ต้องการ **การอนุมัติการจับคู่แบบครั้งเดียว** — แม้ว่าคุณจะอยู่ในTailnetเดียวกัน
กับ `gateway.auth.allowTailscale: true` ก็ตาม นี่เป็นมาตรการด้านความปลอดภัยเพื่อป้องกัน
การเข้าถึงโดยไม่ได้รับอนุญาต นี่เป็นมาตรการด้านความปลอดภัยเพื่อป้องกันการเข้าถึงโดยไม่ได้รับอนุญาต

**สิ่งที่คุณจะเห็น:** "disconnected (1008): pairing required"

**วิธีอนุมัติอุปกรณ์:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

เมื่ออนุมัติแล้ว อุปกรณ์จะถูกจดจำและไม่ต้องอนุมัติซ้ำ เว้นแต่คุณจะเพิกถอนด้วย `openclaw devices revoke --device <id> --role <role>`. ดู
[Devices CLI](/cli/devices) สำหรับการหมุนเวียนโทเคนและการเพิกถอน

**หมายเหตุ:**

- การเชื่อมต่อภายในเครื่อง (`127.0.0.1`) จะถูกอนุมัติโดยอัตโนมัติ
- การเชื่อมต่อระยะไกล (LAN, Tailnet ฯลฯ) ต้องการการอนุมัติอย่างชัดเจน ต้องได้รับการอนุมัติอย่างชัดเจน
- โปรไฟล์เบราว์เซอร์แต่ละรายการจะสร้างรหัสอุปกรณ์เฉพาะ ดังนั้นการสลับเบราว์เซอร์หรือ
  การล้างข้อมูลเบราว์เซอร์จะต้องจับคู่ใหม่

## ทำอะไรได้บ้าง (ตอนนี้)

- แชทกับโมเดลผ่าน Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- สตรีมการเรียกเครื่องมือ + การ์ดเอาต์พุตเครื่องมือแบบสดในแชท (อีเวนต์เอเจนต์)
- ช่องทาง: WhatsApp/Telegram/Discord/Slack + ช่องทางปลั๊กอิน (Mattermost เป็นต้น) ช่องทาง: สถานะ WhatsApp/Telegram/Discord/Slack + ช่องทางปลั๊กอิน (Mattermost ฯลฯ) + การเข้าสู่ระบบด้วยQR + คอนฟิกต่อช่องทาง (`channels.status`, `web.login.*`, `config.patch`)
- Instances: รายการการแสดงตน + รีเฟรช (`system-presence`)
- เซสชัน: รายการ + การตั้งค่า override การคิด/โหมด verbose ต่อเซสชัน (`sessions.list`, `sessions.patch`)
- งานCron: แสดงรายการ/เพิ่ม/รัน/เปิดใช้งาน/ปิดใช้งาน + ประวัติการรัน (`cron.*`)
- Skills: สถานะ เปิดใช้งาน/ปิดใช้งาน ติดตั้ง อัปเดตคีย์API (`skills.*`)
- โหนด: แสดงรายการ + ความสามารถ (`node.list`)
- การอนุมัติการรันคำสั่ง: แก้ไขรายการอนุญาตของGatewayหรือโหนด + นโยบายถามสำหรับ `exec host=gateway/node` (`exec.approvals.*`)
- คอนฟิก: ดู/แก้ไข `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- คอนฟิก: ใช้ค่า + รีสตาร์ตพร้อมการตรวจสอบ (`config.apply`) และปลุกเซสชันที่ใช้งานล่าสุด
- การเขียนคอนฟิกรวมถึงตัวป้องกัน base-hash เพื่อป้องกันการเขียนทับการแก้ไขพร้อมกัน
- สคีมาคอนฟิก + การเรนเดอร์ฟอร์ม (`config.schema` รวมถึงสคีมาของปลั๊กอิน + ช่องทาง); ตัวแก้ไข JSON แบบดิบยังคงใช้งานได้
- ดีบัก: สแนปช็อตสถานะ/สุขภาพ/โมเดล + บันทึกอีเวนต์ + การเรียก RPC ด้วยตนเอง (`status`, `health`, `models.list`)
- ล็อก: tail แบบสดของไฟล์ล็อกGateway พร้อมตัวกรอง/ส่งออก (`logs.tail`)
- อัปเดต: รันการอัปเดตแพ็กเกจ/กิต + รีสตาร์ต (`update.run`) พร้อมรายงานการรีสตาร์ต

หมายเหตุแผงงานCron:

- สำหรับงานแบบแยกเดี่ยว การส่งมอบจะตั้งค่าเริ่มต้นเป็นการประกาศสรุป สำหรับงานแบบแยกเดี่ยว การส่งมอบค่าเริ่มต้นคือประกาศสรุป คุณสามารถสลับเป็นไม่มีได้หากต้องการรันภายในเท่านั้น
- ฟิลด์ช่องทาง/เป้าหมายจะแสดงเมื่อเลือกประกาศ

## พฤติกรรมการแชท

- `chat.send` เป็นแบบ **ไม่บล็อก**: จะตอบรับทันทีด้วย `{ runId, status: "started" }` และสตรีมคำตอบผ่านอีเวนต์ `chat`
- การส่งซ้ำด้วย `idempotencyKey` เดิม จะคืนค่า `{ status: "in_flight" }` ระหว่างกำลังรัน และ `{ status: "ok" }` หลังเสร็จสิ้น
- `chat.inject` จะเพิ่มโน้ตผู้ช่วยลงในทรานสคริปต์ของเซสชันและกระจายอีเวนต์ `chat` สำหรับอัปเดตเฉพาะUI (ไม่รันเอเจนต์ ไม่ส่งไปยังช่องทาง)
- หยุด:
  - คลิก **Stop** (เรียก `chat.abort`)
  - พิมพ์ `/stop` (หรือ `stop|esc|abort|wait|exit|interrupt`) เพื่อยกเลิกนอกแบนด์
  - `chat.abort` รองรับ `{ sessionKey }` (ไม่มี `runId`) เพื่อยกเลิกรันที่กำลังทำงานทั้งหมดของเซสชันนั้น

## การเข้าถึงผ่านTailnet (แนะนำ)

### Tailscale Serve แบบผสานรวม (แนะนำ)

ให้Gatewayอยู่บน loopback และให้ Tailscale Serve ทำหน้าที่พร็อกซีด้วยHTTPS:

```bash
openclaw gateway --tailscale serve
```

เปิด:

- `https://<magicdns>/` (หรือ `gateway.controlUi.basePath` ที่คุณตั้งค่าไว้)

ตามค่าเริ่มต้น คำขอ Serve สามารถยืนยันตัวตนผ่านเฮดเดอร์เอกลักษณ์ของTailscale
(`tailscale-user-login`) เมื่อ `gateway.auth.allowTailscale` เป็น `true`. OpenClaw
จะตรวจสอบเอกลักษณ์โดยการ resolve ที่อยู่ `x-forwarded-for` ด้วย
`tailscale whois` และจับคู่กับเฮดเดอร์ และจะยอมรับเฉพาะเมื่อคำขอเข้าถึง loopback พร้อมเฮดเดอร์ `x-forwarded-*` ของTailscale เท่านั้น ตั้งค่า
`gateway.auth.allowTailscale: false` (หรือบังคับ `gateway.auth.mode: "password"`)
หากคุณต้องการบังคับใช้โทเคน/รหัสผ่านแม้สำหรับทราฟฟิก Serve ตั้งค่า
`gateway.auth.allowTailscale: false` (หรือบังคับ `gateway.auth.mode: "password"`)
หากต้องการบังคับใช้โทเค็น/รหัสผ่านแม้กับทราฟฟิก Serve

### ผูกกับtailnet + โทเคน

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

จากนั้นเปิด:

- `http://<tailscale-ip>:18789/` (หรือ `gateway.controlUi.basePath` ที่คุณตั้งค่าไว้)

วางโทเคนลงในการตั้งค่าUI (ส่งเป็น `connect.params.auth.token`).

## HTTP ที่ไม่ปลอดภัย

หากคุณเปิดแดชบอร์ดผ่าน HTTP ปกติ (`http://<lan-ip>` หรือ `http://<tailscale-ip>`),
เบราว์เซอร์จะทำงานใน **บริบทที่ไม่ปลอดภัย** และบล็อก WebCrypto ตามค่าเริ่มต้น
OpenClaw จะ **บล็อก** การเชื่อมต่อ Control UI ที่ไม่มีเอกลักษณ์อุปกรณ์ โดยค่าเริ่มต้น OpenClaw จะ **บล็อก** การเชื่อมต่อ Control UI ที่ไม่มีตัวตนอุปกรณ์

**วิธีแก้ไขที่แนะนำ:** ใช้ HTTPS (Tailscale Serve) หรือเปิดUIในเครื่อง:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (บนโฮสต์Gateway)

**ตัวอย่างการลดระดับ (ใช้โทเคนอย่างเดียวผ่านHTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

การตั้งค่านี้จะปิดการระบุอุปกรณ์ + การจับคู่สำหรับ Control UI (แม้บนHTTPS) ใช้เฉพาะเมื่อคุณเชื่อถือเครือข่าย ใช้เฉพาะเมื่อคุณเชื่อถือเครือข่าย

ดู [Tailscale](/gateway/tailscale) สำหรับคำแนะนำการตั้งค่าHTTPS

## การสร้างUI

Gateway ให้บริการไฟล์สแตติกจาก `dist/control-ui`. สร้างด้วย:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

ฐานแบบสัมบูรณ์เสริม (เมื่อคุณต้องการURLของแอสเซ็ตแบบคงที่):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

สำหรับการพัฒนาในเครื่อง (เซิร์ฟเวอร์พัฒนาแยก):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

จากนั้นชี้UIไปยังURL Gateway WS ของคุณ (เช่น `ws://127.0.0.1:18789`).

## การดีบัก/ทดสอบ: เซิร์ฟเวอร์พัฒนา + Gateway ระยะไกล

Control UI เป็นไฟล์สแตติก; เป้าหมาย WebSocket สามารถกำหนดค่าได้และอาจแตกต่างจาก HTTP origin สิ่งนี้มีประโยชน์เมื่อคุณต้องการใช้ Vite dev server ในเครื่อง แต่ให้Gatewayรันอยู่ที่อื่น มีประโยชน์เมื่อคุณต้องการ Vite dev server อยู่ในเครื่อง แต่ให้ Gateway รันที่อื่น

1. เริ่มเซิร์ฟเวอร์พัฒนาUI: `pnpm ui:dev`
2. เปิดURLลักษณะนี้:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

การยืนยันตัวตนแบบครั้งเดียวเสริม (หากจำเป็น):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

หมายเหตุ:

- `gatewayUrl` จะถูกเก็บใน localStorage หลังโหลดและลบออกจากURL
- `token` ถูกเก็บใน localStorage; `password` ถูกเก็บไว้ในหน่วยความจำเท่านั้น
- เมื่อกำหนด `gatewayUrl` แล้ว UI จะไม่ถอยกลับไปใช้คอนฟิกหรือข้อมูลรับรองจากสภาพแวดล้อม
  ให้ระบุ `token` (หรือ `password`) อย่างชัดเจน การขาดข้อมูลรับรองที่ระบุชัดเจนถือเป็นข้อผิดพลาด
  ระบุ `token` (หรือ `password`) อย่างชัดเจน การไม่มีข้อมูลรับรองที่ระบุชัดเจนถือเป็นข้อผิดพลาด
- ใช้ `wss://` เมื่อGatewayอยู่หลังTLS (Tailscale Serve, พร็อกซีHTTPS ฯลฯ)
- `gatewayUrl` จะยอมรับเฉพาะในหน้าต่างระดับบนสุด (ไม่ฝัง) เพื่อป้องกัน clickjacking
- สำหรับการพัฒนาข้ามออริจิน (เช่น `pnpm ui:dev` ไปยังGatewayระยะไกล) ให้เพิ่มออริจินของUIไปยัง `gateway.controlUi.allowedOrigins`

ตัวอย่าง:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

รายละเอียดการตั้งค่าการเข้าถึงระยะไกล: [Remote access](/gateway/remote).
