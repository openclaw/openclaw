---
summary: "วงจรชีวิตของAgent loop การสตรีม และความหมายของการรอ"
read_when:
  - คุณต้องการคำอธิบายแบบละเอียดของAgent loopหรือเหตุการณ์ในวงจรชีวิต
title: "Agent Loop"
---

# Agent Loop (OpenClaw)

Agentic loop คือการรันแบบ “จริง” เต็มรูปแบบของเอเจนต์: การรับเข้า → การประกอบบริบท → การอนุมานของโมเดล →
การรันเครื่องมือ → การสตรีมคำตอบ → การบันทึกถาวร นี่คือเส้นทางหลักที่เปลี่ยนข้อความให้กลายเป็นการกระทำ
และคำตอบสุดท้าย โดยยังคงทำให้สถานะของเซสชันสอดคล้องกัน 12. นี่คือเส้นทางหลักที่เชื่อถือได้ซึ่งเปลี่ยนข้อความ
ให้เป็นการกระทำและคำตอบสุดท้าย พร้อมทั้งรักษาสถานะเซสชันให้สอดคล้องกัน

ใน OpenClaw หนึ่งลูปคือการรันแบบลำดับเดียวต่อหนึ่งเซสชัน ซึ่งจะปล่อยอีเวนต์ของวงจรชีวิตและสตรีม
ขณะที่โมเดลคิด เรียกใช้เครื่องมือ และสตรีมเอาต์พุต เอกสารนี้อธิบายว่าลูปที่แท้จริงนั้นถูกเชื่อมต่อแบบครบวงจรอย่างไร 13. เอกสารนี้อธิบายว่าลูปที่แท้จริงนั้น
เชื่อมต่อแบบ end-to-end อย่างไร

## Entry points

- Gateway RPC: `agent` และ `agent.wait`.
- CLI: คำสั่ง `agent`.

## How it works (high-level)

1. `agent` RPC ตรวจสอบพารามิเตอร์ แก้ไขเซสชัน (sessionKey/sessionId) บันทึกเมตาดาตาของเซสชัน และส่งกลับ `{ runId, acceptedAt }` ทันที
2. `agentCommand` รันเอเจนต์:
   - แก้ไขโมเดล + ค่าเริ่มต้นของ thinking/verbose
   - โหลดสแนปช็อตของ Skills
   - เรียก `runEmbeddedPiAgent` (pi-agent-core runtime)
   - ปล่อย **lifecycle end/error** หากลูปที่ฝังอยู่ไม่ปล่อยอีเวนต์ดังกล่าว
3. `runEmbeddedPiAgent`:
   - จัดลำดับการรันผ่านคิวต่อเซสชัน + คิวส่วนกลาง
   - แก้ไขโมเดล + โปรไฟล์การยืนยันตัวตน และสร้าง pi session
   - สมัครรับอีเวนต์จาก pi และสตรีมเดลตาของ assistant/เครื่องมือ
   - บังคับใช้ timeout -> ยกเลิกการรันเมื่อเกินเวลา
   - ส่งคืนเพย์โหลด + เมตาดาตาการใช้งาน
4. `subscribeEmbeddedPiSession` เชื่อมอีเวนต์ของ pi-agent-core เข้ากับสตรีม `agent` ของ OpenClaw:
   - อีเวนต์ของเครื่องมือ => `stream: "tool"`
   - เดลตาของ assistant => `stream: "assistant"`
   - อีเวนต์ของวงจรชีวิต => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` ใช้ `waitForAgentJob`:
   - รอ **lifecycle end/error** สำหรับ `runId`
   - ส่งคืน `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Queueing + concurrency

- การรันจะถูกจัดลำดับต่อ session key (session lane) และอาจผ่าน lane ส่วนกลางเพิ่มเติม
- วิธีนี้ป้องกันการชนกันของเครื่องมือ/เซสชัน และทำให้ประวัติเซสชันสอดคล้องกัน
- ช่องทางการส่งข้อความสามารถเลือกโหมดคิว (collect/steer/followup) ที่ป้อนเข้าสู่ระบบ lane นี้
  ดู [Command Queue](/concepts/queue)
  14. ดูที่ [Command Queue](/concepts/queue)

## Session + workspace preparation

- แก้ไขและสร้าง Workspace; การรันแบบ sandbox อาจเปลี่ยนเส้นทางไปยังราก Workspace ของ sandbox
- โหลด Skills (หรือใช้ซ้ำจากสแนปช็อต) และฉีดเข้าไปใน env และพรอมป์ต์
- แก้ไขไฟล์ bootstrap/บริบท และฉีดเข้าไปในรายงาน system prompt
- ได้รับล็อกการเขียนของเซสชัน; เปิดและเตรียม `SessionManager` ก่อนเริ่มสตรีม

## Prompt assembly + system prompt

- system prompt ถูกสร้างจาก base prompt ของ OpenClaw, prompt ของ Skills, บริบท bootstrap และ override ต่อการรัน
- บังคับใช้ขีดจำกัดเฉพาะของโมเดลและโทเคนสำรองสำหรับการบีบอัด
- ดู [System prompt](/concepts/system-prompt) สำหรับสิ่งที่โมเดลเห็น

## Hook points (where you can intercept)

OpenClaw มีระบบ hook สองแบบ:

- **Internal hooks** (Gateway hooks): สคริปต์แบบขับเคลื่อนด้วยอีเวนต์สำหรับคำสั่งและอีเวนต์ของวงจรชีวิต
- **Plugin hooks**: จุดขยายภายในวงจรชีวิตของเอเจนต์/เครื่องมือและไปป์ไลน์ของ Gateway

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: รันขณะสร้างไฟล์ bootstrap ก่อนที่ system prompt จะถูกสรุปขั้นสุดท้าย
  ใช้เพื่อเพิ่ม/ลบบริบท bootstrap
  15. ใช้สิ่งนี้เพื่อเพิ่ม/ลบไฟล์ bootstrap context
- **Command hooks**: `/new`, `/reset`, `/stop`, และอีเวนต์คำสั่งอื่นๆ (ดูเอกสาร Hooks)

ดู [Hooks](/automation/hooks) สำหรับการตั้งค่าและตัวอย่าง

### Plugin hooks (agent + gateway lifecycle)

สิ่งเหล่านี้รันภายใน agent loop หรือไปป์ไลน์ของ Gateway:

- **`before_agent_start`**: ฉีดบริบทหรือ override system prompt ก่อนเริ่มการรัน
- **`agent_end`**: ตรวจสอบรายการข้อความสุดท้ายและเมตาดาตาการรันหลังเสร็จสิ้น
- **`before_compaction` / `after_compaction`**: สังเกตหรือใส่คำอธิบายรอบการบีบอัด
- **`before_tool_call` / `after_tool_call`**: ดักจับพารามิเตอร์/ผลลัพธ์ของเครื่องมือ
- **`tool_result_persist`**: แปลงผลลัพธ์ของเครื่องมือแบบซิงโครนัสก่อนเขียนลงในทรานสคริปต์ของเซสชัน
- **`message_received` / `message_sending` / `message_sent`**: hook ข้อความขาเข้า + ขาออก
- **`session_start` / `session_end`**: ขอบเขตวงจรชีวิตของเซสชัน
- **`gateway_start` / `gateway_stop`**: อีเวนต์วงจรชีวิตของ Gateway

ดู [Plugins](/tools/plugin#plugin-hooks) สำหรับ API ของ hook และรายละเอียดการลงทะเบียน

## Streaming + partial replies

- เดลตาของ assistant ถูกสตรีมจาก pi-agent-core และปล่อยเป็นอีเวนต์ `assistant`
- สตรีมแบบบล็อกสามารถปล่อยคำตอบบางส่วนได้บน `text_end` หรือ `message_end`
- การสตรีมเหตุผลสามารถปล่อยเป็นสตรีมแยกหรือเป็นบล็อกของคำตอบ
- ดู [Streaming](/concepts/streaming) สำหรับพฤติกรรมการแบ่งชิ้นและบล็อกคำตอบ

## Tool execution + messaging tools

- อีเวนต์เริ่ม/อัปเดต/จบของเครื่องมือถูกปล่อยบนสตรีม `tool`
- ผลลัพธ์ของเครื่องมือถูกทำความสะอาดด้านขนาดและเพย์โหลดรูปภาพก่อนบันทึก/ปล่อย
- การส่งผ่านเครื่องมือส่งข้อความถูกติดตามเพื่อระงับการยืนยันซ้ำจาก assistant

## Reply shaping + suppression

- เพย์โหลดสุดท้ายถูกประกอบจาก:
  - ข้อความของ assistant (และเหตุผลเพิ่มเติมถ้ามี)
  - สรุปเครื่องมือแบบอินไลน์ (เมื่อ verbose + อนุญาต)
  - ข้อความข้อผิดพลาดของ assistant เมื่อโมเดลเกิดข้อผิดพลาด
- `NO_REPLY` ถูกปฏิบัติเป็นโทเคนเงียบและถูกกรองออกจากเพย์โหลดขาออก
- รายการเพย์โหลดสุดท้ายจะลบรายการซ้ำจากเครื่องมือส่งข้อความ
- หากไม่เหลือเพย์โหลดที่แสดงผลได้และเครื่องมือเกิดข้อผิดพลาด จะปล่อยคำตอบสำรองของข้อผิดพลาดจากเครื่องมือ
  (ยกเว้นกรณีที่เครื่องมือส่งข้อความได้ส่งคำตอบที่ผู้ใช้มองเห็นแล้ว)

## Compaction + retries

- การบีบอัดอัตโนมัติปล่อยอีเวนต์สตรีม `compaction` และอาจกระตุ้นให้เกิดการลองใหม่
- เมื่อมีการลองใหม่ บัฟเฟอร์ในหน่วยความจำและสรุปเครื่องมือจะถูกรีเซ็ตเพื่อหลีกเลี่ยงเอาต์พุตซ้ำ
- ดู [Compaction](/concepts/compaction) สำหรับไปป์ไลน์การบีบอัด

## Event streams (today)

- `lifecycle`: ปล่อยโดย `subscribeEmbeddedPiSession` (และเป็น fallback โดย `agentCommand`)
- `assistant`: เดลตาที่สตรีมจาก pi-agent-core
- `tool`: อีเวนต์ของเครื่องมือที่สตรีมจาก pi-agent-core

## Chat channel handling

- เดลตาของ assistant ถูกบัฟเฟอร์เป็นข้อความแชต `delta`
- แชต `final` จะถูกปล่อยเมื่อเกิด **lifecycle end/error**

## Timeouts

- ค่าเริ่มต้นของ `agent.wait`: 30 วินาที (เฉพาะการรอ) พารามิเตอร์ `timeoutMs` ใช้ override ได้ 16. พารามิเตอร์ `timeoutMs` จะถูกใช้แทนค่าเดิม
- Agent runtime: ค่าเริ่มต้น `agents.defaults.timeoutSeconds` 600 วินาที; บังคับใช้ในตัวจับเวลา abort ของ `runEmbeddedPiAgent`

## Where things can end early

- Agent timeout (abort)
- AbortSignal (ยกเลิก)
- การตัดการเชื่อมต่อของ Gateway หรือ RPC timeout
- `agent.wait` timeout (เฉพาะการรอ ไม่ได้หยุดเอเจนต์)
