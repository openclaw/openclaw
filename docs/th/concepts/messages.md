---
summary: "โฟลว์ของข้อความ เซสชัน การจัดคิว และการมองเห็นเหตุผล"
read_when:
  - อธิบายว่าข้อความขาเข้ากลายเป็นคำตอบได้อย่างไร
  - ชี้แจงเรื่องเซสชัน โหมดการจัดคิว หรือพฤติกรรมการสตรีม
  - จัดทำเอกสารเกี่ยวกับการมองเห็นเหตุผลและผลกระทบต่อการใช้งาน
title: "Messages"
---

# Messages

หน้านี้เชื่อมโยงภาพรวมของวิธีที่ OpenClaw จัดการข้อความขาเข้า เซสชัน การจัดคิว
การสตรีม และการมองเห็นเหตุผล

## Message flow (ภาพรวมระดับสูง)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

ตัวปรับแต่งหลักอยู่ในการกำหนดค่า:

- `messages.*` สำหรับคำนำหน้า การจัดคิว และพฤติกรรมของกลุ่ม
- `agents.defaults.*` สำหรับค่าเริ่มต้นของ block streaming และ chunking
- การ override ระดับช่องทาง (`channels.whatsapp.*`, `channels.telegram.*` ฯลฯ) สำหรับขีดจำกัดและสวิตช์การสตรีม for caps and streaming toggles.

ดู [Configuration](/gateway/configuration) สำหรับสคีมาฉบับเต็ม

## Inbound dedupe

Channels can redeliver the same message after reconnects. ช่องทางอาจส่งข้อความเดิมซ้ำหลังจากการเชื่อมต่อใหม่ OpenClaw จะเก็บแคชระยะสั้น
ที่อ้างอิงด้วย channel/account/peer/session/message id เพื่อไม่ให้การส่งซ้ำ
ไปกระตุ้นการรันเอเจนต์อีกครั้ง

## Inbound debouncing

ข้อความที่ส่งมาต่อเนื่องอย่างรวดเร็วจาก **ผู้ส่งเดียวกัน** สามารถถูกรวมเป็นหนึ่งเทิร์นของเอเจนต์ได้ผ่าน `messages.inbound` การทำ debouncing จะกำหนดขอบเขตต่อช่องทาง + บทสนทนา
และใช้ข้อความล่าสุดสำหรับการผูกเธรดการตอบกลับ/ID Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

คอนฟิก (ค่าเริ่มต้นแบบ global + override รายช่องทาง):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

หมายเหตุ:

- Debounce ใช้กับข้อความ **ข้อความล้วน** เท่านั้น; สื่อ/ไฟล์แนบจะถูกส่งทันที
- คำสั่งควบคุมจะข้ามการ debouncing เพื่อให้คงเป็นเอกเทศ

## Sessions and devices

เซสชันเป็นของ Gateway ไม่ใช่ของไคลเอนต์

- แชตแบบตรงจะถูกรวมเข้าเป็นคีย์เซสชันหลักของเอเจนต์
- กลุ่ม/ช่องทางจะมีคีย์เซสชันของตนเอง
- ที่เก็บเซสชันและทรานสคริปต์อยู่บนโฮสต์Gateway

Multiple devices/channels can map to the same session, but history is not fully
synced back to every client. Recommendation: use one primary device for long
conversations to avoid divergent context. The Control UI and TUI always show the
gateway-backed session transcript, so they are the source of truth.

รายละเอียด: [Session management](/concepts/session)

## Inbound bodies and history context

OpenClaw แยก **prompt body** ออกจาก **command body**:

- `Body`: prompt text sent to the agent. This may include channel envelopes and
  optional history wrappers.
- `CommandBody`: ข้อความดิบจากผู้ใช้สำหรับการแยกคำสั่ง/ไดเรกทีฟ
- `RawBody`: นามแฝงแบบเดิมของ `CommandBody` (คงไว้เพื่อความเข้ากันได้)

เมื่อช่องทางส่งประวัติมา จะใช้ wrapper ร่วมกันดังนี้:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

สำหรับ **แชตที่ไม่ใช่แบบตรง** (กลุ่ม/ช่องทาง/ห้อง) **เนื้อหาข้อความปัจจุบัน** จะถูกเติมคำนำหน้าด้วย
ป้ายผู้ส่ง (รูปแบบเดียวกับที่ใช้ในรายการประวัติ) เพื่อให้ข้อความแบบเรียลไทม์และแบบจัดคิว/ประวัติ
มีความสอดคล้องกันใน prompt ของเอเจนต์ This keeps real-time and queued/history
messages consistent in the agent prompt.

บัฟเฟอร์ประวัติเป็นแบบ **pending-only**: จะรวมข้อความกลุ่มที่ _ไม่ได้_
กระตุ้นการรัน (เช่น ข้อความที่ถูกจำกัดด้วยการกล่าวถึง) และ **ไม่รวม** ข้อความ
ที่อยู่ในทรานสคริปต์ของเซสชันแล้ว

Directive stripping only applies to the **current message** section so history
remains intact. Channels that wrap history should set `CommandBody` (or
`RawBody`) to the original message text and keep `Body` as the combined prompt.
การตัดไดเรกทีฟจะใช้กับส่วน **ข้อความปัจจุบัน** เท่านั้น เพื่อให้ประวัติยังคงสมบูรณ์
ช่องทางที่ wrap ประวัติควรกำหนด `CommandBody` (หรือ
`RawBody`) เป็นข้อความต้นฉบับ และเก็บ `Body` เป็น prompt ที่รวมแล้ว
บัฟเฟอร์ประวัติสามารถกำหนดค่าได้ผ่าน `messages.groupChat.historyLimit` (ค่าเริ่มต้นแบบ global)
และ override รายช่องทาง เช่น `channels.slack.historyLimit` หรือ
`channels.telegram.accounts.<id>.historyLimit` (ตั้งค่า `0` เพื่อปิดใช้งาน)

## Queueing and followups

หากมีการรันที่กำลังทำงานอยู่ ข้อความขาเข้าสามารถถูกจัดคิว ปรับทิศทางเข้าสู่
การรันปัจจุบัน หรือถูกรวบรวมสำหรับเทิร์นถัดไป

- กำหนดค่าผ่าน `messages.queue` (และ `messages.queue.byChannel`)
- โหมด: `interrupt`, `steer`, `followup`, `collect` รวมถึงรูปแบบ backlog

รายละเอียด: [Queueing](/concepts/queue)

## Streaming, chunking, and batching

Block streaming จะส่งคำตอบบางส่วนออกไปตามที่โมเดลสร้างบล็อกข้อความ
Chunking จะคำนึงถึงขีดจำกัดข้อความของช่องทางและหลีกเลี่ยงการตัดโค้ดที่อยู่ใน fenced code
Chunking respects channel text limits and avoids splitting fenced code.

การตั้งค่าหลัก:

- `agents.defaults.blockStreamingDefault` (`on|off`, ปิดเป็นค่าเริ่มต้น)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (batching ตามช่วงว่าง)
- `agents.defaults.humanDelay` (หยุดแบบมนุษย์ระหว่างการตอบแบบบล็อก)
- Override ระดับช่องทาง: `*.blockStreaming` และ `*.blockStreamingCoalesce` (ช่องทางที่ไม่ใช่ Telegram ต้องตั้งค่า `*.blockStreaming: true` อย่างชัดเจน)

รายละเอียด: [Streaming + chunking](/concepts/streaming)

## Reasoning visibility and tokens

OpenClaw สามารถแสดงหรือซ่อนเหตุผลของโมเดลได้:

- `/reasoning on|off|stream` ควบคุมการมองเห็น
- เนื้อหาเหตุผลยังคงนับรวมการใช้โทเคนเมื่อโมเดลสร้างขึ้น
- Telegram รองรับการสตรีมเหตุผลเข้าไปในบับเบิลแบบร่าง

รายละเอียด: [Thinking + reasoning directives](/tools/thinking) และ [Token use](/reference/token-use)

## Prefixes, threading, and replies

การจัดรูปแบบข้อความขาออกถูกรวมศูนย์ไว้ที่ `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, และ `channels.<channel>.accounts.<id>.responsePrefix` (ลำดับการซ้อนของคำนำหน้าขาออก) รวมถึง `channels.whatsapp.messagePrefix` (คำนำหน้าขาเข้า WhatsApp)
- การผูกเธรดการตอบกลับผ่าน `replyToMode` และค่าเริ่มต้นรายช่องทาง

รายละเอียด: [Configuration](/gateway/configuration#messages) และเอกสารของแต่ละช่องทาง
