---
summary: "พื้นผิวเว็บของGateway: Control UI, โหมดการผูก(bind)และความปลอดภัย"
read_when:
  - คุณต้องการเข้าถึงGatewayผ่านTailscale
  - คุณต้องการใช้Control UIบนเบราว์เซอร์และการแก้ไขคอนฟิก
title: "เว็บ"
---

# เว็บ(Gateway)

Gateway ให้บริการ **Control UIบนเบราว์เซอร์** ขนาดเล็ก(Vite + Lit)จากพอร์ตเดียวกับ Gateway WebSocket:

- ค่าเริ่มต้น: `http://<host>:18789/`
- พรีฟิกซ์เสริม: ตั้งค่า `gateway.controlUi.basePath` (เช่น `/openclaw`)

ความสามารถต่าง ๆ อยู่ใน [Control UI](/web/control-ui)
ความสามารถต่างๆอยู่ที่ [Control UI](/web/control-ui)
หน้านี้เน้นที่โหมดการผูก(bind), ความปลอดภัย และพื้นผิวที่เปิดสู่เว็บ

## Webhooks

เมื่อ `hooks.enabled=true`, Gateway จะเปิดเผยเอ็นด์พอยต์ webhook ขนาดเล็กบน HTTP server เดียวกันด้วย
ดู [Gateway configuration](/gateway/configuration) → `hooks` สำหรับการยืนยันตัวตนและเพย์โหลด
ดู [Gateway configuration](/gateway/configuration) → `hooks` สำหรับการยืนยันตัวตน + เพย์โหลด

## คอนฟิก(เปิดเป็นค่าเริ่มต้น)

Control UI **เปิดใช้งานเป็นค่าเริ่มต้น** เมื่อมีแอสเซ็ตอยู่ (`dist/control-ui`)
คุณสามารถควบคุมได้ผ่านคอนฟิก:
คุณสามารถควบคุมได้ผ่านคอนฟิก:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## การเข้าถึงผ่านTailscale

### Integrated Serve (แนะนำ)

ให้Gatewayอยู่บน loopback และให้ Tailscale Serve ทำหน้าที่พร็อกซี:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

จากนั้นเริ่มgateway:

```bash
openclaw gateway
```

เปิด:

- `https://<magicdns>/` (หรือ `gateway.controlUi.basePath` ที่คุณตั้งค่าไว้)

### Tailnet bind + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

จากนั้นเริ่มgateway (ต้องใช้โทเคนสำหรับการผูกที่ไม่ใช่ loopback):

```bash
openclaw gateway
```

เปิด:

- `http://<tailscale-ip>:18789/` (หรือ `gateway.controlUi.basePath` ที่คุณตั้งค่าไว้)

### อินเทอร์เน็ตสาธารณะ(Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## หมายเหตุด้านความปลอดภัย

- โดยค่าเริ่มต้นต้องมีการยืนยันตัวตนของGateway (โทเคน/รหัสผ่านหรือเฮดเดอร์ตัวตนของTailscale)
- การผูกที่ไม่ใช่ loopback **ยังคงต้อง** ใช้โทเคน/รหัสผ่านที่ใช้ร่วมกัน (`gateway.auth` หรือผ่าน env)
- ตัวช่วยตั้งค่าจะสร้างโทเคนของgatewayให้โดยค่าเริ่มต้น (แม้บน loopback)
- UI จะส่ง `connect.params.auth.token` หรือ `connect.params.auth.password`
- Control UI ส่งเฮดเดอร์ป้องกันการคลิกแจ็กกิง และยอมรับเฉพาะการเชื่อมต่อ websocket จากเบราว์เซอร์แบบ same-origin
  เว้นแต่จะตั้งค่า `gateway.controlUi.allowedOrigins`
- เมื่อใช้ Serve เฮดเดอร์ตัวตนของTailscaleสามารถใช้ผ่านการยืนยันตัวตนได้เมื่อ
  `gateway.auth.allowTailscale` เป็น `true` (ไม่ต้องใช้โทเคน/รหัสผ่าน) ตั้งค่า
  `gateway.auth.allowTailscale: false` เพื่อบังคับใช้ข้อมูลรับรองอย่างชัดเจน ดู
  [Tailscale](/gateway/tailscale) และ [Security](/gateway/security) ตั้งค่า
  `gateway.auth.allowTailscale: false` เพื่อบังคับใช้ข้อมูลรับรองอย่างชัดเจน ดู
  [Tailscale](/gateway/tailscale) และ [Security](/gateway/security)
- `gateway.tailscale.mode: "funnel"` ต้องใช้ `gateway.auth.mode: "password"` (รหัสผ่านที่ใช้ร่วมกัน)

## การสร้างUI

Gateway ให้บริการไฟล์สแตติกจาก `dist/control-ui` สร้างด้วย: สร้างด้วย:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
