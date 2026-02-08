---
summary: "เรียกใช้เครื่องมือเดี่ยวโดยตรงผ่านเอ็นด์พอยต์ HTTP ของ Gateway"
read_when:
  - การเรียกใช้เครื่องมือโดยไม่ต้องรันรอบการทำงานของเอเจนต์เต็มรูปแบบ
  - การสร้างออโตเมชันที่ต้องการการบังคับใช้นโยบายของเครื่องมือ
title: "Tools Invoke API"
x-i18n:
  source_path: gateway/tools-invoke-http-api.md
  source_hash: 17ccfbe0b0d9bb61
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:13Z
---

# Tools Invoke (HTTP)

Gateway ของ OpenClaw เปิดเผยเอ็นด์พอยต์ HTTP แบบเรียบง่ายสำหรับการเรียกใช้เครื่องมือเดี่ยวโดยตรง โดยจะเปิดใช้งานเสมอ แต่ถูกควบคุมด้วยการยืนยันตัวตนของ Gateway และนโยบายของเครื่องมือ

- `POST /tools/invoke`
- ใช้พอร์ตเดียวกับ Gateway (มัลติเพล็กซ์ WS + HTTP): `http://<gateway-host>:<port>/tools/invoke`

ขนาดเพย์โหลดสูงสุดเริ่มต้นคือ 2 MB

## Authentication

ใช้การกำหนดค่าการยืนยันตัวตนของ Gateway ส่ง bearer token:

- `Authorization: Bearer <token>`

หมายเหตุ:

- เมื่อ `gateway.auth.mode="token"` ให้ใช้ `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`).
- เมื่อ `gateway.auth.mode="password"` ให้ใช้ `gateway.auth.password` (หรือ `OPENCLAW_GATEWAY_PASSWORD`).

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

ฟิลด์:

- `tool` (string, จำเป็น): ชื่อเครื่องมือที่จะเรียกใช้
- `action` (string, ไม่บังคับ): จะถูกแมปเข้า args หากสคีมาของเครื่องมือรองรับ `action` และเพย์โหลด args ไม่ได้ระบุฟิลด์นี้
- `args` (object, ไม่บังคับ): อาร์กิวเมนต์เฉพาะของเครื่องมือ
- `sessionKey` (string, ไม่บังคับ): คีย์เซสชันเป้าหมาย หากไม่ระบุหรือเป็น `"main"` Gateway จะใช้คีย์เซสชันหลักที่ตั้งค่าไว้ (คำนึงถึง `session.mainKey` และเอเจนต์เริ่มต้น หรือ `global` ในสโคปส่วนกลาง)
- `dryRun` (boolean, ไม่บังคับ): สงวนไว้สำหรับการใช้งานในอนาคต ปัจจุบันจะถูกละเว้น

## Policy + routing behavior

ความพร้อมใช้งานของเครื่องมือจะถูกกรองผ่านสายโซ่นโยบายเดียวกับที่ใช้โดยเอเจนต์ของ Gateway:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- นโยบายกลุ่ม (หากคีย์เซสชันแมปไปยังกลุ่มหรือช่องทาง)
- นโยบายซับเอเจนต์ (เมื่อเรียกใช้ด้วยคีย์เซสชันของซับเอเจนต์)

หากเครื่องมือไม่ได้รับอนุญาตตามนโยบาย เอ็นด์พอยต์จะส่งคืน **404**

เพื่อช่วยให้นโยบายกลุ่มสามารถระบุบริบทได้ คุณสามารถตั้งค่าเพิ่มเติมได้ดังนี้:

- `x-openclaw-message-channel: <channel>` (ตัวอย่าง: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (เมื่อมีหลายบัญชี)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (คำขอไม่ถูกต้องหรือเกิดข้อผิดพลาดของเครื่องมือ)
- `401` → ไม่ได้รับอนุญาต
- `404` → เครื่องมือไม่พร้อมใช้งาน (ไม่พบหรือไม่อยู่ในรายการอนุญาต)
- `405` → ไม่อนุญาตเมธอด

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
