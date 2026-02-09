---
summary: "แผน: เพิ่มเอ็นด์พอยต์ OpenResponses /v1/responses และเลิกใช้ chat completions อย่างเป็นระเบียบ"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "แผน OpenResponses Gateway"
---

# แผนการผสานรวม OpenResponses Gateway

## บริบท

OpenClaw Gateway ในปัจจุบันเปิดให้ใช้งานเอ็นด์พอยต์ Chat Completions ที่เข้ากันได้กับ OpenAI แบบพื้นฐานที่
`/v1/chat/completions` (ดู [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses เป็นมาตรฐานการอนุมานแบบเปิดที่อิงตาม OpenAI Responses API โดยออกแบบมาสำหรับเวิร์กโฟลว์เชิงเอเจนต์ และใช้ข้อมูลนำเข้าแบบเป็นรายการร่วมกับอีเวนต์การสตรีมเชิงความหมาย สเปก OpenResponses กำหนด `/v1/responses` ไม่ใช่ `/v1/chat/completions`. It is designed
for agentic workflows and uses item-based inputs plus semantic streaming events. The OpenResponses
spec defines `/v1/responses`, not `/v1/chat/completions`.

## เป้าหมาย

- เพิ่มเอ็นด์พอยต์ `/v1/responses` ที่สอดคล้องกับ semantics ของ OpenResponses
- คง Chat Completions ไว้เป็นชั้นความเข้ากันได้ที่ปิดใช้งานได้ง่ายและสามารถนำออกได้ในอนาคต
- ทำให้การตรวจสอบและการพาร์สเป็นมาตรฐานด้วยสคีมาที่แยกส่วนและนำกลับมาใช้ซ้ำได้

## Non-goals

- ความสามารถ OpenResponses ครบถ้วนทั้งหมดในรอบแรก (รูปภาพ ไฟล์ เครื่องมือที่โฮสต์)
- การแทนที่ตรรกะการรันเอเจนต์ภายในหรือการจัดการเครื่องมือ
- การเปลี่ยนพฤติกรรม `/v1/chat/completions` ที่มีอยู่ในเฟสแรก

## สรุปการวิจัย

แหล่งที่มา: OpenResponses OpenAPI, เว็บไซต์สเปก OpenResponses และบล็อก Hugging Face

ประเด็นสำคัญที่สกัดได้:

- `POST /v1/responses` รับฟิลด์ `CreateResponseBody` เช่น `model`, `input` (สตริงหรือ
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` และ
  `max_tool_calls`.
- `ItemParam` เป็นยูเนียนแบบแยกประเภท ประกอบด้วย:
  - รายการ `message` ที่มีบทบาท `system`, `developer`, `user`, `assistant`
  - `function_call` และ `function_call_output`
  - `reasoning`
  - `item_reference`
- การตอบกลับที่สำเร็จจะคืนค่า `ResponseResource` ที่มีรายการ `object: "response"`, `status` และ
  `output`.
- การสตรีมใช้อีเวนต์เชิงความหมาย เช่น:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- สเปกระบุข้อกำหนด:
  - `Content-Type: text/event-stream`
  - `event:` ต้องตรงกับฟิลด์ JSON `type`
  - อีเวนต์สุดท้ายต้องเป็นค่าลิเทอรัล `[DONE]`
- รายการการให้เหตุผลอาจเปิดเผย `content`, `encrypted_content` และ `summary`.
- ตัวอย่างจาก HF มีการใช้ `OpenResponses-Version: latest` ในคำขอ (เฮดเดอร์แบบไม่บังคับ)

## สถาปัตยกรรมที่เสนอ

- เพิ่ม `src/gateway/open-responses.schema.ts` ที่ประกอบด้วย Zod schemas เท่านั้น (ไม่อิมพอร์ตจาก gateway)
- เพิ่ม `src/gateway/openresponses-http.ts` (หรือ `open-responses-http.ts`) สำหรับ `/v1/responses`.
- คง `src/gateway/openai-http.ts` ไว้เหมือนเดิมในฐานะอะแดปเตอร์ความเข้ากันได้แบบเดิม
- เพิ่มคอนฟิก `gateway.http.endpoints.responses.enabled` (ค่าเริ่มต้น `false`)
- คง `gateway.http.endpoints.chatCompletions.enabled` ให้เป็นอิสระ อนุญาตให้สลับเปิดปิดเอ็นด์พอยต์ทั้งสองแยกกันได้
- แสดงคำเตือนตอนเริ่มต้นระบบเมื่อเปิดใช้งาน Chat Completions เพื่อสื่อถึงสถานะ legacy

## เส้นทางการเลิกใช้ Chat Completions

- รักษาขอบเขตโมดูลอย่างเคร่งครัด: ไม่แชร์ประเภทสคีมาระหว่าง responses และ chat completions
- ทำให้ Chat Completions เป็นแบบ opt-in ผ่านคอนฟิก เพื่อปิดได้โดยไม่ต้องเปลี่ยนโค้ด
- อัปเดตเอกสารให้ระบุ Chat Completions เป็น legacy เมื่อ `/v1/responses` มีเสถียรภาพ
- ตัวเลือกในอนาคต: แมปคำขอ Chat Completions ไปยังตัวจัดการ Responses เพื่อให้การนำออกง่ายขึ้น

## ชุดความสามารถที่รองรับในเฟส 1

- รับ `input` เป็นสตริงหรือ `ItemParam[]` ที่มีบทบาทของข้อความและ `function_call_output`.
- แยกข้อความ system และ developer ไปไว้ใน `extraSystemPrompt`.
- ใช้ `user` หรือ `function_call_output` ล่าสุดเป็นข้อความปัจจุบันสำหรับการรันเอเจนต์
- ปฏิเสธส่วนเนื้อหาที่ไม่รองรับ (รูปภาพ/ไฟล์) ด้วย `invalid_request_error`.
- ส่งคืนข้อความผู้ช่วยเพียงรายการเดียวพร้อมเนื้อหา `output_text`.
- ส่งคืน `usage` ที่ตั้งค่าเป็นศูนย์ทั้งหมดจนกว่าจะเชื่อมต่อการนับโทเคน

## กลยุทธ์การตรวจสอบความถูกต้อง (ไม่ใช้ SDK)

- ใช้ Zod schemas สำหรับชุดที่รองรับของ:
  - `CreateResponseBody`
  - `ItemParam` + ยูเนียนของส่วนเนื้อหาข้อความ
  - `ResponseResource`
  - รูปแบบอีเวนต์สตรีมที่ gateway ใช้
- เก็บสคีมาไว้ในโมดูลเดียวที่แยกจากกันเพื่อหลีกเลี่ยงความคลาดเคลื่อนและรองรับการสร้างโค้ดในอนาคต

## การทำสตรีม (เฟส 1)

- บรรทัด SSE ที่มีทั้ง `event:` และ `data:`.
- ลำดับที่จำเป็น (ขั้นต่ำที่ใช้งานได้):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (ทำซ้ำตามต้องการ)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## แผนการทดสอบและการตรวจสอบ

- เพิ่มความครอบคลุม e2e สำหรับ `/v1/responses`:
  - ต้องมีการยืนยันตัวตน
  - รูปแบบการตอบกลับแบบไม่สตรีม
  - ลำดับอีเวนต์สตรีมและ `[DONE]`
  - การกำหนดเส้นทางเซสชันด้วยเฮดเดอร์และ `user`
- คง `src/gateway/openai-http.e2e.test.ts` โดยไม่เปลี่ยนแปลง
- ทดสอบด้วยตนเอง: ใช้ curl ไปที่ `/v1/responses` พร้อม `stream: true` และตรวจสอบลำดับอีเวนต์และ
  `[DONE]` สุดท้าย

## การอัปเดตเอกสาร (ภายหลัง)

- เพิ่มหน้าเอกสารใหม่สำหรับการใช้งานและตัวอย่างของ `/v1/responses`.
- อัปเดต `/gateway/openai-http-api` พร้อมหมายเหตุ legacy และลิงก์ไปยัง `/v1/responses`.
