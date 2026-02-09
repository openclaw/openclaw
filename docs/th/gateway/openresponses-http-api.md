---
summary: "เปิดเผยเอ็นด์พอยต์ HTTP /v1/responses ที่เข้ากันได้กับ OpenResponses จาก Gateway"
read_when:
  - ผสานรวมไคลเอนต์ที่ใช้ OpenResponses API
  - คุณต้องการอินพุตแบบอิงไอเท็ม การเรียกเครื่องมือฝั่งไคลเอนต์ หรืออีเวนต์ SSE
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

Gateway ของ OpenClaw สามารถให้บริการเอ็นด์พอยต์ `POST /v1/responses` ที่เข้ากันได้กับ OpenResponses

เอ็นด์พอยต์นี้ **ปิดใช้งานเป็นค่าเริ่มต้น** ต้องเปิดใช้งานในคอนฟิกก่อน เปิดใช้งานใน config ก่อน

- `POST /v1/responses`
- ใช้พอร์ตเดียวกับ Gateway (มัลติเพล็กซ์ WS + HTTP): `http://<gateway-host>:<port>/v1/responses`

ภายใน ระบบจะรันคำขอเหมือนการรันเอเจนต์ของ Gateway ตามปกติ (ใช้โค้ดพาธเดียวกับ
`openclaw agent`) ดังนั้นการกำหนดเส้นทาง/สิทธิ์/คอนฟิกจะตรงกับ Gateway ของคุณ

## การยืนยันตัวตน

ใช้คอนฟิกการยืนยันตัวตนของ Gateway ส่ง bearer token: ส่ง bearer token:

- `Authorization: Bearer <token>`

หมายเหตุ:

- เมื่อ `gateway.auth.mode="token"` ให้ใช้ `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`)
- เมื่อ `gateway.auth.mode="password"` ให้ใช้ `gateway.auth.password` (หรือ `OPENCLAW_GATEWAY_PASSWORD`)

## การเลือกเอเจนต์

ไม่ต้องใช้เฮดเดอร์พิเศษ: เข้ารหัส agent id ในฟิลด์ OpenResponses `model`:

- `model: "openclaw:<agentId>"` (ตัวอย่าง: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (นามแฝง)

หรือระบุเอเจนต์ OpenClaw เฉพาะด้วยเฮดเดอร์:

- `x-openclaw-agent-id: <agentId>` (ค่าเริ่มต้น: `main`)

ขั้นสูง:

- `x-openclaw-session-key: <sessionKey>` เพื่อควบคุมการกำหนดเส้นทางเซสชันอย่างเต็มที่

## การเปิดใช้งานเอ็นด์พอยต์

ตั้งค่า `gateway.http.endpoints.responses.enabled` เป็น `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## การปิดใช้งานเอ็นด์พอยต์

ตั้งค่า `gateway.http.endpoints.responses.enabled` เป็น `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## พฤติกรรมของเซสชัน

โดยค่าเริ่มต้น เอ็นด์พอยต์จะเป็น **ไร้สถานะต่อคำขอ** (จะสร้างคีย์เซสชันใหม่ทุกครั้งที่เรียก)

หากคำขอมีสตริง OpenResponses `user` Gateway จะสร้างคีย์เซสชันที่คงที่จากค่านั้น
ทำให้การเรียกซ้ำสามารถใช้เซสชันเอเจนต์ร่วมกันได้

## รูปแบบคำขอ (ที่รองรับ)

คำขอเป็นไปตาม OpenResponses API พร้อมอินพุตแบบอิงไอเท็ม การรองรับปัจจุบัน: การรองรับปัจจุบัน:

- `input`: สตริงหรืออาร์เรย์ของอ็อบเจ็กต์ไอเท็ม
- `instructions`: ถูกรวมเข้ากับ system prompt
- `tools`: คำจำกัดความเครื่องมือฝั่งไคลเอนต์ (function tools)
- `tool_choice`: กรองหรือบังคับใช้เครื่องมือฝั่งไคลเอนต์
- `stream`: เปิดใช้งานการสตรีม SSE
- `max_output_tokens`: ขีดจำกัดเอาต์พุตแบบ best-effort (ขึ้นกับผู้ให้บริการ)
- `user`: การกำหนดเส้นทางเซสชันแบบคงที่

ยอมรับได้แต่ **ยังถูกละเลยในขณะนี้**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## ไอเท็ม (อินพุต)

### `message`

บทบาท: `system`, `developer`, `user`, `assistant`.

- `system` และ `developer` จะถูกต่อท้ายใน system prompt
- ไอเท็ม `user` หรือ `function_call_output` ที่ล่าสุดจะกลายเป็น “ข้อความปัจจุบัน”
- ข้อความผู้ใช้/ผู้ช่วยก่อนหน้า จะถูกรวมเป็นประวัติเพื่อบริบท

### `function_call_output` (เครื่องมือแบบผลัดตา)

ส่งผลลัพธ์เครื่องมือกลับไปยังโมเดล:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` และ `item_reference`

ยอมรับเพื่อความเข้ากันได้ของสคีมา แต่ถูกละเลยเมื่อสร้าง prompt

## เครื่องมือ (function tools ฝั่งไคลเอนต์)

ระบุเครื่องมือด้วย `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

หากเอเจนต์ตัดสินใจเรียกเครื่องมือ การตอบกลับจะส่งคืนไอเท็มเอาต์พุต `function_call`.
จากนั้นคุณส่งคำขอต่อเนื่องพร้อม `function_call_output` เพื่อดำเนินเทิร์นต่อ

## รูปภาพ (`input_image`)

รองรับแหล่งที่มาแบบ base64 หรือ URL:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

ชนิด MIME ที่อนุญาต (ปัจจุบัน): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
ขนาดสูงสุด (ปัจจุบัน): 10MB

## ไฟล์ (`input_file`)

รองรับแหล่งที่มาแบบ base64 หรือ URL:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

ชนิด MIME ที่อนุญาต (ปัจจุบัน): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

ขนาดสูงสุด (ปัจจุบัน): 5MB

พฤติกรรมปัจจุบัน:

- เนื้อหาไฟล์จะถูกถอดรหัสและเพิ่มเข้าไปใน **system prompt** ไม่ใช่ข้อความผู้ใช้
  เพื่อให้เป็นแบบชั่วคราว (ไม่ถูกเก็บถาวรในประวัติเซสชัน)
- ไฟล์ PDF จะถูกแยกข้อความ PDF จะถูกแยกข้อความ หากพบข้อความน้อย หน้าต้น ๆ จะถูกแรสเตอร์เป็นภาพ
  แล้วส่งให้โมเดล

การแยก PDF ใช้บิลด์ legacy ของ `pdfjs-dist` ที่เป็นมิตรกับ Node (ไม่มี worker) การแยก PDF ใช้บิลด์ legacy ของ `pdfjs-dist` ที่เป็นมิตรกับ Node (ไม่ใช้ worker) บิลด์สมัยใหม่ของ
PDF.js คาดหวัง browser workers/DOM globals จึงไม่ถูกใช้ใน Gateway

ค่าเริ่มต้นการดึง URL:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- คำขอถูกป้องกัน (การแก้ DNS, การบล็อก IP ส่วนตัว, จำกัดการรีไดเร็กต์, ไทม์เอาต์)

## ขีดจำกัดไฟล์และรูปภาพ (คอนฟิก)

สามารถปรับค่าเริ่มต้นได้ที่ `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

ค่าเริ่มต้นเมื่อไม่ได้ระบุ:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## การสตรีม (SSE)

ตั้งค่า `stream: true` เพื่อรับ Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- แต่ละบรรทัดอีเวนต์คือ `event: <type>` และ `data: <json>`
- สตรีมสิ้นสุดด้วย `data: [DONE]`

ชนิดอีเวนต์ที่ส่งออกในปัจจุบัน:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (เมื่อเกิดข้อผิดพลาด)

## การใช้งาน

`usage` จะถูกเติมค่าเมื่อผู้ให้บริการพื้นฐานรายงานจำนวนโทเคน

## ข้อผิดพลาด

ข้อผิดพลาดใช้วัตถุ JSON ลักษณะดังนี้:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

กรณีที่พบบ่อย:

- `401` การยืนยันตัวตนขาดหาย/ไม่ถูกต้อง
- `400` เนื้อหาคำขอไม่ถูกต้อง
- `405` ใช้เมธอดไม่ถูกต้อง

## ตัวอย่าง

ไม่สตรีม:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

สตรีม:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
