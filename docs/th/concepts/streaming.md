---
summary: "พฤติกรรมการสตรีมและการแบ่งชิ้นส่วน(การตอบแบบบล็อก การสตรีมแบบร่าง ข้อจำกัด)"
read_when:
  - อธิบายวิธีการทำงานของการสตรีมหรือการแบ่งชิ้นส่วนบนช่องทาง
  - การเปลี่ยนพฤติกรรม block streaming หรือ channel chunking
  - การดีบักการตอบแบบบล็อกที่ซ้ำ/มาก่อนเวลา หรือการสตรีมแบบร่าง
title: "การสตรีมและการแบ่งชิ้นส่วน"
---

# นี่คือข้อความของช่องทางปกติ (ไม่ใช่ token deltas)

OpenClaw มีเลเยอร์ “การสตรีม” แยกกันสองชั้น:

- **Block streaming (ช่องทาง):** ส่ง **บล็อก** ที่เสร็จสมบูรณ์ออกมาเมื่อผู้ช่วยเขียนเสร็จ เป็นข้อความปกติของช่องทาง (ไม่ใช่เดลตาโทเคน) การสตรีมร่างของ Telegram เป็นพื้นผิวการสตรีมแบบบางส่วนเพียงอย่างเดียว
- **Token-ish streaming (เฉพาะ Telegram):** อัปเดต **บับเบิลแบบร่าง** ด้วยข้อความบางส่วนระหว่างการสร้างคำตอบ; ข้อความสุดท้ายจะถูกส่งเมื่อจบ

ปัจจุบัน **ไม่มีการสตรีมโทเคนจริง** ไปยังข้อความของช่องทางภายนอก การสตรีมแบบร่างของ Telegram เป็นพื้นผิวการสตรีมบางส่วนเพียงอย่างเดียว สิ่งนี้ช่วยลด “สแปมบรรทัดเดียว” ขณะยังคงให้เอาต์พุตแบบค่อยเป็นค่อยไป

## Block streaming (ข้อความของช่องทาง)

Block streaming จะส่งเอาต์พุตของผู้ช่วยเป็นชิ้นใหญ่ ๆ เมื่อพร้อมใช้งาน

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: อีเวนต์สตรีมของโมเดล (อาจเบาบางสำหรับโมเดลที่ไม่สตรีม)
- `chunker`: `EmbeddedBlockChunker` ที่ใช้ขอบเขตต่ำ/สูง + ความต้องการจุดตัด
- `channel send`: ข้อความขาออกจริง (การตอบแบบบล็อก)

**การควบคุม:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (ปิดเป็นค่าเริ่มต้น)
- การ override ต่อช่องทาง: `*.blockStreaming` (และแบบต่อบัญชี) เพื่อบังคับ `"on"`/`"off"` ต่อช่องทาง
- `agents.defaults.blockStreamingBreak`: `"text_end"` หรือ `"message_end"`
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (รวมบล็อกที่สตรีมก่อนส่ง)
- เพดานสูงสุดของช่องทาง: `*.textChunkLimit` (เช่น `channels.whatsapp.textChunkLimit`)
- โหมดการแบ่งชิ้นของช่องทาง: `*.chunkMode` (`length` เป็นค่าเริ่มต้น, `newline` จะแบ่งตามบรรทัดว่าง(ขอบเขตย่อหน้า)ก่อนแบ่งตามความยาว)
- เพดานแบบ soft ของ Discord: `channels.discord.maxLinesPerMessage` (ค่าเริ่มต้น 17) แบ่งคำตอบที่ยาวมากเพื่อหลีกเลี่ยงการตัดใน UI

**ความหมายของขอบเขต:**

- `text_end`: สตรีมบล็อกทันทีที่ตัวแบ่งชิ้นปล่อยออกมา; flush ทุกครั้งที่ `text_end`
- `message_end`: รอจนข้อความของผู้ช่วยเสร็จสิ้น แล้วจึง flush เอาต์พุตที่บัฟเฟอร์ไว้

`message_end` ยังคงใช้ตัวแบ่งชิ้นหากข้อความที่บัฟเฟอร์เกิน `maxChars` ดังนั้นจึงอาจปล่อยหลายชิ้นพร้อมกันในตอนท้าย

## อัลกอริทึมการแบ่งชิ้น (ขอบเขตต่ำ/สูง)

การแบ่งชิ้นแบบบล็อกถูกทำโดย `EmbeddedBlockChunker`:

- **ขอบเขตต่ำ:** จะไม่ปล่อยจนกว่าบัฟเฟอร์ >= `minChars` (เว้นแต่ถูกบังคับ)
- **ขอบเขตสูง:** เลือกแบ่งก่อนถึง `maxChars`; หากถูกบังคับ ให้แบ่งที่ `maxChars`
- **ความต้องการจุดตัด:** `paragraph` → `newline` → `sentence` → `whitespace` → แบ่งแบบแข็ง
- **โค้ดเฟนซ์:** ห้ามแบ่งภายในเฟนซ์; เมื่อจำเป็นต้องแบ่งที่ `maxChars` ให้ปิดแล้วเปิดเฟนซ์ใหม่เพื่อคงความถูกต้องของ Markdown

`maxChars` จะถูกหนีบตาม `textChunkLimit` ของช่องทาง ดังนั้นจึงไม่สามารถเกินเพดานต่อช่องทางได้

## การรวม (รวมบล็อกที่สตรีม)

เมื่อเปิด block streaming แล้ว OpenClaw สามารถ **รวมชิ้นบล็อกที่ต่อเนื่องกัน**
ก่อนส่งออก เพื่อลด “สแปมบรรทัดเดี่ยว” ในขณะที่ยังให้เอาต์พุตแบบคืบหน้า สิ่งนี้ทำให้การตอบแบบหลายบับเบิลดูเป็นธรรมชาติมากขึ้น

- การรวมจะรอ **ช่วงว่างที่ไม่มีกิจกรรม** (`idleMs`) ก่อน flush
- บัฟเฟอร์ถูกจำกัดด้วย `maxChars` และจะ flush หากเกินค่า
- `minChars` ป้องกันไม่ให้ส่งชิ้นเล็ก ๆ จนกว่าจะมีข้อความสะสมเพียงพอ
  (การ flush ครั้งสุดท้ายจะส่งข้อความที่เหลือทั้งหมด)
- ตัวเชื่อมถูกอนุมานจาก `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → เว้นวรรค)
- มีการ override ต่อช่องทางผ่าน `*.blockStreamingCoalesce` (รวมถึงคอนฟิกแบบต่อบัญชี)
- ค่าเริ่มต้นของการรวม `minChars` จะถูกปรับเป็น 1500 สำหรับ Signal/Slack/Discord เว้นแต่จะมีการ override

## จังหวะเหมือนมนุษย์ระหว่างบล็อก

เมื่อเปิด block streaming คุณสามารถเพิ่ม **การหน่วงแบบสุ่ม** ระหว่าง
การตอบแบบบล็อก (หลังบล็อกแรก) เพื่อให้การตอบหลายบับเบิลดูเป็นธรรมชาติมากขึ้น This makes multi-bubble responses feel
more natural.

- คอนฟิก: `agents.defaults.humanDelay` (override ต่อเอเจนต์ผ่าน `agents.list[].humanDelay`)
- โหมด: `off` (ค่าเริ่มต้น), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`)
- ใช้กับ **การตอบแบบบล็อก** เท่านั้น ไม่รวมการตอบสุดท้ายหรือสรุปเครื่องมือ

## “สตรีมเป็นชิ้นหรือส่งทั้งหมด”

ช่องทางที่ไม่ใช่ Telegram ก็ต้องตั้งค่า `*.blockStreaming: true` ด้วย

- **สตรีมเป็นชิ้น:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (ปล่อยไปตามที่สร้าง) ช่องทางที่ไม่ใช่ Telegram ต้องตั้ง `*.blockStreaming: true` เพิ่ม Telegram สามารถสตรีมร่าง
  (`channels.telegram.streamMode`) โดยไม่ต้องใช้การตอบแบบบล็อก
- **สตรีมทั้งหมดตอนท้าย:** `blockStreamingBreak: "message_end"` (flush ครั้งเดียว อาจได้หลายชิ้นหากยาวมาก)
- **ไม่ใช้ block streaming:** `blockStreamingDefault: "off"` (ส่งเฉพาะการตอบสุดท้าย)

**หมายเหตุของช่องทาง:** สำหรับช่องทางที่ไม่ใช่ Telegram block streaming จะ **ปิดอยู่เสมอ** เว้นแต่
`*.blockStreaming` จะถูกตั้งค่าเป็น `true` อย่างชัดเจน Telegram สามารถสตรีมแบบร่าง
(`channels.telegram.streamMode`) ได้โดยไม่ต้องมีการตอบแบบบล็อก OpenClaw สร้าง system prompt แบบกำหนดเองสำหรับการรันเอเจนต์ทุกครั้ง

การเตือนตำแหน่งคอนฟิก: ค่าเริ่มต้นของ `blockStreaming*` อยู่ภายใต้
`agents.defaults` ไม่ใช่คอนฟิกราก

## การสตรีมแบบร่างของ Telegram (ลักษณะคล้ายโทเคน)

Telegram เป็นช่องทางเดียวที่มีการสตรีมแบบร่าง:

- ใช้ Bot API `sendMessageDraft` ใน **แชทส่วนตัวที่มีหัวข้อ**
- `channels.telegram.streamMode: "partial" | "block" | "off"`
  - `partial`: อัปเดตร่างด้วยข้อความสตรีมล่าสุด
  - `block`: อัปเดตร่างเป็นบล็อกที่แบ่งชิ้นแล้ว (กฎเดียวกับตัวแบ่งชิ้น)
  - `off`: ไม่มีการสตรีมแบบร่าง
- คอนฟิกการแบ่งชิ้นของร่าง (เฉพาะสำหรับ `streamMode: "block"`): `channels.telegram.draftChunk` (ค่าเริ่มต้น: `minChars: 200`, `maxChars: 800`)
- การสตรีมแบบร่างแยกจาก block streaming; การตอบแบบบล็อกปิดเป็นค่าเริ่มต้นและจะเปิดได้เฉพาะด้วย `*.blockStreaming: true` บนช่องทางที่ไม่ใช่ Telegram
- การตอบสุดท้ายยังคงเป็นข้อความปกติ
- `/reasoning stream` จะเขียนเหตุผลลงในบับเบิลแบบร่าง (เฉพาะ Telegram)

เมื่อการสตรีมแบบร่างทำงาน OpenClaw จะปิด block streaming สำหรับการตอบนั้นเพื่อหลีกเลี่ยงการสตรีมซ้ำซ้อน

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: บับเบิลแบบร่างของ Telegram (ไม่ใช่ข้อความจริง)
- `final reply`: การส่งข้อความ Telegram แบบปกติ
