---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw browser` (โปรไฟล์, แท็บ, แอ็กชัน, รีเลย์ส่วนขยาย)"
read_when:
  - คุณใช้ `openclaw browser` และต้องการตัวอย่างสำหรับงานที่พบบ่อย
  - คุณต้องการควบคุมเบราว์เซอร์ที่รันอยู่บนเครื่องอื่นผ่านโฮสต์โหนด
  - คุณต้องการใช้รีเลย์ส่วนขยาย Chrome (แนบ/ยกเลิกการแนบผ่านปุ่มแถบเครื่องมือ)
title: "เบราว์เซอร์"
---

# `openclaw browser`

จัดการเซิร์ฟเวอร์ควบคุมเบราว์เซอร์ของ OpenClaw และเรียกใช้แอ็กชันของเบราว์เซอร์ (แท็บ, สแน็ปช็อต, สกรีนช็อต, การนำทาง, การคลิก, การพิมพ์)

เกี่ยวข้อง:

- เครื่องมือและAPIของเบราว์เซอร์: [Browser tool](/tools/browser)
- รีเลย์ส่วนขยาย Chrome: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: URL ของGateway WebSocket (ค่าเริ่มต้นจากคอนฟิก)
- `--token <token>`: โทเคนGateway (ถ้าจำเป็น)
- `--timeout <ms>`: ระยะหมดเวลาของคำขอ (มิลลิวินาที)
- `--browser-profile <name>`: เลือกโปรไฟล์เบราว์เซอร์ (ค่าเริ่มต้นจากคอนฟิก)
- `--json`: เอาต์พุตที่อ่านโดยเครื่องได้ (เมื่อรองรับ)

## Quick start (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiles

โปรไฟล์คือคอนฟิกรูตติ้งของเบราว์เซอร์ที่ตั้งชื่อไว้ โดยในทางปฏิบัติ: ในทางปฏิบัติ:

- `openclaw`: เปิดใช้งาน/แนบกับอินสแตนซ์ Chrome ที่ OpenClaw จัดการโดยเฉพาะ (ไดเรกทอรีข้อมูลผู้ใช้ที่แยกออกมา)
- `chrome`: ควบคุมแท็บ Chrome ที่มีอยู่ของคุณผ่านรีเลย์ส่วนขยาย Chrome

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

ใช้โปรไฟล์ที่ระบุ:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
openclaw browser snapshot
```

Screenshot:

```bash
openclaw browser screenshot
```

นำทาง/คลิก/พิมพ์ (ออโตเมชัน UI แบบอ้างอิง):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome extension relay (attach via toolbar button)

โหมดนี้ให้เอเจนต์ควบคุมแท็บ Chrome ที่มีอยู่ซึ่งคุณแนบด้วยตนเอง (จะไม่แนบให้อัตโนมัติ)

ติดตั้งส่วนขยายแบบ unpacked ไปยังพาธที่คงที่:

```bash
openclaw browser extension install
openclaw browser extension path
```

จากนั้นใน Chrome → `chrome://extensions` → เปิดใช้งาน “Developer mode” → “Load unpacked” → เลือกโฟลเดอร์ที่แสดงไว้

คู่มือฉบับเต็ม: [Chrome extension](/tools/chrome-extension)

## Remote browser control (node host proxy)

หากGatewayรันอยู่คนละเครื่องกับเบราว์เซอร์ ให้รัน **โฮสต์โหนด** บนเครื่องที่มี Chrome/Brave/Edge/Chromium จากนั้นGatewayจะพร็อกซีแอ็กชันของเบราว์เซอร์ไปยังโหนดนั้น (ไม่ต้องมีเซิร์ฟเวอร์ควบคุมเบราว์เซอร์แยกต่างหาก) Gateway จะพร็อกซีการทำงานของเบราว์เซอร์ไปยังโหนดนั้น (ไม่ต้องมีเซิร์ฟเวอร์ควบคุมเบราว์เซอร์แยกต่างหาก)

ใช้ `gateway.nodes.browser.mode` เพื่อควบคุมการจัดเส้นทางอัตโนมัติ และใช้ `gateway.nodes.browser.node` เพื่อปักหมุดโหนดเฉพาะเมื่อมีหลายโหนดเชื่อมต่อ

ความปลอดภัยและการตั้งค่าระยะไกล: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
