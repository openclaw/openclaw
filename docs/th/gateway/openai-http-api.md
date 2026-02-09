---
summary: "เปิดให้ใช้งานเอ็นด์พอยต์ HTTP /v1/chat/completions ที่เข้ากันได้กับ OpenAI จาก Gateway"
read_when:
  - การผสานรวมเครื่องมือที่คาดหวัง OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Gateway（เกตเวย์）ของ OpenClaw สามารถให้บริการเอ็นด์พอยต์ Chat Completions ที่เข้ากันได้กับ OpenAI ขนาดเล็กได้

เอ็นด์พอยต์นี้ **ปิดใช้งานเป็นค่าเริ่มต้น** ต้องเปิดใช้งานในการกำหนดค่าก่อน เปิดใช้งานใน config ก่อน

- `POST /v1/chat/completions`
- พอร์ตเดียวกับ Gateway (มัลติเพล็กซ์ WS + HTTP): `http://<gateway-host>:<port>/v1/chat/completions`

ภายใต้ระบบ คำขอจะถูกรันเหมือนการรันเอเจนต์ของ Gateway ตามปกติ (โค้ดพาธเดียวกับ `openclaw agent`) ดังนั้นการกำหนดเส้นทาง/สิทธิ์/คอนฟิกจะตรงกับ Gateway ของคุณ

## Authentication

ใช้การกำหนดค่า auth ของ Gateway ส่ง bearer token: ส่ง bearer token:

- `Authorization: Bearer <token>`

หมายเหตุ:

- เมื่อ `gateway.auth.mode="token"` ให้ใช้ `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`)
- เมื่อ `gateway.auth.mode="password"` ให้ใช้ `gateway.auth.password` (หรือ `OPENCLAW_GATEWAY_PASSWORD`)

## การเลือกเอเจนต์

ไม่ต้องใช้เฮดเดอร์พิเศษ: เข้ารหัส agent id ในฟิลด์ OpenAI `model`:

- `model: "openclaw:<agentId>"` (ตัวอย่าง: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (นามแฝง)

หรือระบุเอเจนต์ OpenClaw เฉพาะด้วยเฮดเดอร์:

- `x-openclaw-agent-id: <agentId>` (ค่าเริ่มต้น: `main`)

ขั้นสูง:

- `x-openclaw-session-key: <sessionKey>` เพื่อควบคุมการกำหนดเส้นทางเซสชันอย่างเต็มรูปแบบ

## การเปิดใช้งานเอ็นด์พอยต์

ตั้งค่า `gateway.http.endpoints.chatCompletions.enabled` เป็น `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## การปิดใช้งานเอ็นด์พอยต์

ตั้งค่า `gateway.http.endpoints.chatCompletions.enabled` เป็น `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## พฤติกรรมของเซสชัน

โดยค่าเริ่มต้น เอ็นด์พอยต์จะเป็นแบบ **ไร้สถานะต่อคำขอ** (มีการสร้างคีย์เซสชันใหม่ทุกครั้งที่เรียก)

หากคำขอมีสตริง OpenAI `user` ทาง Gateway จะอนุมานคีย์เซสชันที่คงที่จากสตริงนั้น ทำให้การเรียกซ้ำสามารถแชร์เซสชันเอเจนต์เดียวกันได้

## Streaming (SSE)

ตั้งค่า `stream: true` เพื่อรับ Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- แต่ละบรรทัดอีเวนต์คือ `data: <json>`
- สตรีมสิ้นสุดด้วย `data: [DONE]`

## ตัวอย่าง

ไม่สตรีม:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

สตรีม:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
