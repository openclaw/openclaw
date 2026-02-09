---
summary: "ผสานรวม Tailscale Serve/Funnel สำหรับแดชบอร์ดGateway"
read_when:
  - การเปิดเผยGateway Control UI นอก localhost
  - การทำให้อัตโนมัติการเข้าถึงแดชบอร์ดของ tailnet หรือสาธารณะ
title: "Tailscale"
---

# Tailscale (แดชบอร์ดGateway)

OpenClaw สามารถตั้งค่า Tailscale **Serve** (tailnet) หรือ **Funnel** (สาธารณะ) ให้โดยอัตโนมัติสำหรับ
แดชบอร์ดGatewayและพอร์ตWebSocket วิธีนี้ช่วยให้Gatewayผูกกับ loopback ไว้ ขณะที่
Tailscale ให้บริการ HTTPS การกำหนดเส้นทาง และ (สำหรับ Serve) ส่วนหัวเอกลักษณ์ตัวตน สิ่งนี้ทำให้เกตเวย์ผูกกับ loopback ขณะที่
Tailscale จัดหา HTTPS การกำหนดเส้นทาง และ (สำหรับ Serve) เฮดเดอร์ระบุตัวตน

## โหมด

- `serve`: Serve เฉพาะ tailnet ผ่าน `tailscale serve` โดยGatewayยังคงอยู่บน `127.0.0.1`. เกตเวย์ยังคงอยู่ที่ `127.0.0.1`
- `funnel`: HTTPS สาธารณะผ่าน `tailscale funnel` OpenClawต้องใช้รหัสผ่านที่ใช้ร่วมกัน OpenClaw ต้องใช้รหัสผ่านที่ใช้ร่วมกัน
- `off`: ค่าเริ่มต้น (ไม่ทำงานอัตโนมัติด้วย Tailscale)

## การยืนยันตัวตน

ตั้งค่า `gateway.auth.mode` เพื่อควบคุมการจับมือ:

- `token` (ค่าเริ่มต้นเมื่อมีการตั้งค่า `OPENCLAW_GATEWAY_TOKEN`)
- `password` (คีย์ลับที่ใช้ร่วมกันผ่าน `OPENCLAW_GATEWAY_PASSWORD` หรือคอนฟิก)

เมื่อ `tailscale.mode = "serve"` และ `gateway.auth.allowTailscale` เป็น `true`,
คำขอพร็อกซี Serve ที่ถูกต้องสามารถยืนยันตัวตนผ่านส่วนหัวเอกลักษณ์ของ Tailscale
(`tailscale-user-login`) ได้โดยไม่ต้องส่งโทเคน/รหัสผ่าน OpenClawจะตรวจสอบ
เอกลักษณ์โดยแก้ไขที่อยู่ `x-forwarded-for` ผ่านเดมอน Tailscale ภายในเครื่อง
(`tailscale whois`) และจับคู่กับส่วนหัวก่อนยอมรับคำขอ
OpenClawจะถือว่าคำขอเป็น Serve เฉพาะเมื่อมาจาก loopback พร้อมส่วนหัวของ Tailscale
`x-forwarded-for`, `x-forwarded-proto`, และ `x-forwarded-host` เท่านั้น
หากต้องการบังคับให้ใช้ข้อมูลรับรองอย่างชัดเจน ให้ตั้งค่า `gateway.auth.allowTailscale: false` หรือ
บังคับใช้ `gateway.auth.mode: "password"`. OpenClaw ตรวจสอบ
ตัวตนโดยแก้ไขที่อยู่ `x-forwarded-for` ผ่าน Tailscale
เดมอนภายในเครื่อง (`tailscale whois`) และจับคู่กับเฮดเดอร์ก่อนยอมรับ
OpenClaw จะถือว่าคำขอเป็น Serve ก็ต่อเมื่อมาจาก loopback พร้อม
เฮดเดอร์ `x-forwarded-for`, `x-forwarded-proto`, และ `x-forwarded-host`
ของ Tailscale
เพื่อบังคับใช้ข้อมูลรับรองแบบชัดเจน ให้ตั้งค่า `gateway.auth.allowTailscale: false` หรือ
บังคับ `gateway.auth.mode: "password"`

## ตัวอย่างคอนฟิก

### เฉพาะ tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

เปิด: `https://<magicdns>/` (หรือ `gateway.controlUi.basePath` ที่คุณตั้งค่าไว้)

### เฉพาะ tailnet (ผูกกับ IP ของ Tailnet)

ใช้กรณีนี้เมื่อคุณต้องการให้Gatewayรับฟังโดยตรงบน IP ของ Tailnet (ไม่ใช้ Serve/Funnel)

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

เชื่อมต่อจากอุปกรณ์ Tailnet อื่น:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

หมายเหตุ: loopback (`http://127.0.0.1:18789`) จะ **ไม่** ทำงานในโหมดนี้

### อินเทอร์เน็ตสาธารณะ (Funnel + รหัสผ่านที่ใช้ร่วมกัน)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

ควรใช้ `OPENCLAW_GATEWAY_PASSWORD` แทนการบันทึกรหัสผ่านลงดิสก์

## ตัวอย่าง CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## หมายเหตุ

- Tailscale Serve/Funnel ต้องติดตั้งและล็อกอิน CLI ของ `tailscale`
- `tailscale.mode: "funnel"` จะปฏิเสธการเริ่มทำงานหากโหมดการยืนยันตัวตนไม่ใช่ `password` เพื่อหลีกเลี่ยงการเปิดเผยต่อสาธารณะ
- ตั้งค่า `gateway.tailscale.resetOnExit` หากต้องการให้ OpenClaw ยกเลิกการตั้งค่า `tailscale serve`
  หรือ `tailscale funnel` เมื่อปิดการทำงาน
- `gateway.bind: "tailnet"` คือการผูกกับ Tailnet โดยตรง (ไม่มี HTTPS ไม่มี Serve/Funnel)
- `gateway.bind: "auto"` ให้ความสำคัญกับ loopback; ใช้ `tailnet` หากต้องการเฉพาะ tailnet
- Serve/Funnel เปิดเผยเฉพาะ **Gateway control UI + WS** Serve/Funnel จะเปิดเผยเฉพาะ **Gateway control UI + WS** เท่านั้น โหนดจะเชื่อมต่อผ่าน
  Gateway WS endpoint เดียวกัน ดังนั้น Serve จึงใช้สำหรับการเข้าถึงโหนดได้

## การควบคุมเบราว์เซอร์ (Gateway ระยะไกล + เบราว์เซอร์ภายในเครื่อง)

หากคุณรันGatewayบนเครื่องหนึ่งแต่ต้องการควบคุมเบราว์เซอร์บนอีกเครื่องหนึ่ง
ให้รัน **โฮสต์โหนด** บนเครื่องที่มีเบราว์เซอร์ และให้ทั้งสองอยู่ใน tailnet เดียวกัน
Gatewayจะพร็อกซีการทำงานของเบราว์เซอร์ไปยังโหนด โดยไม่ต้องมีเซิร์ฟเวอร์ควบคุมแยกหรือ URL ของ Serve
เกตเวย์จะพร็อกซีการกระทำของเบราว์เซอร์ไปยังโหนด; ไม่ต้องมีเซิร์ฟเวอร์ควบคุมแยกหรือ URL ของ Serve

หลีกเลี่ยงการใช้ Funnel สำหรับการควบคุมเบราว์เซอร์ และให้ปฏิบัติกับการจับคู่โหนดเหมือนการเข้าถึงของผู้ปฏิบัติการ

## ข้อกำหนดเบื้องต้น + ข้อจำกัดของ Tailscale

- Serve ต้องเปิดใช้ HTTPS สำหรับ tailnet ของคุณ; CLI จะถามหากยังไม่ได้เปิด
- Serve จะแทรกส่วนหัวเอกลักษณ์ของ Tailscale; Funnel จะไม่ทำ
- Funnel ต้องใช้ Tailscale v1.38.3+ MagicDNS เปิด HTTPS และแอตทริบิวต์โหนด funnel
- Funnel รองรับเฉพาะพอร์ต `443`, `8443`, และ `10000` ผ่าน TLS
- Funnel บน macOS ต้องใช้แอป Tailscale เวอร์ชันโอเพนซอร์ส

## เรียนรู้เพิ่มเติม

- ภาพรวม Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- คำสั่ง `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- ภาพรวม Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- คำสั่ง `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
