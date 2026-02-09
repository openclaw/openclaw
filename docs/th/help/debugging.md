---
summary: "เครื่องมือดีบัก: โหมด watch, สตรีมโมเดลดิบ และการติดตามการรั่วไหลของเหตุผล"
read_when:
  - คุณต้องตรวจสอบเอาต์พุตโมเดลดิบเพื่อดูการรั่วไหลของเหตุผล
  - คุณต้องการรัน Gateway ในโหมด watch ระหว่างการพัฒนาแบบวนรอบ
  - คุณต้องการเวิร์กโฟลว์การดีบักที่ทำซ้ำได้
title: "การดีบัก"
---

# การดีบัก

หน้านี้ครอบคลุมตัวช่วยการดีบักสำหรับเอาต์พุตแบบสตรีม โดยเฉพาะเมื่อผู้ให้บริการผสมเนื้อหาเหตุผลเข้ากับข้อความปกติ

## การ override ดีบักระหว่างรันไทม์

ใช้ `/debug` ในแชตเพื่อกำหนดการ override คอนฟิกแบบ **เฉพาะรันไทม์** (อยู่ในหน่วยความจำ ไม่เขียนดิสก์)
`/debug` ถูกปิดใช้งานเป็นค่าเริ่มต้น; เปิดใช้งานด้วย `commands.debug: true`.
`/debug` ถูกปิดใช้งานโดยค่าเริ่มต้น; เปิดได้ด้วย `commands.debug: true`
วิธีนี้สะดวกเมื่อคุณต้องสลับการตั้งค่าที่ไม่ค่อยใช้โดยไม่ต้องแก้ไข `openclaw.json`.

ตัวอย่าง:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` จะล้างการ override ทั้งหมดและกลับไปใช้คอนฟิกบนดิสก์

## โหมด watch ของ Gateway

สำหรับการพัฒนาแบบรวดเร็ว ให้รัน gateway ภายใต้ตัวเฝ้าดูไฟล์:

```bash
pnpm gateway:watch --force
```

สิ่งนี้แมปไปยัง:

```bash
tsx watch src/entry.ts gateway --force
```

เพิ่มแฟล็ก CLI ของ gateway ใดๆ ต่อท้าย `gateway:watch` แล้วแฟล็กเหล่านั้นจะถูกส่งผ่าน
ทุกครั้งที่รีสตาร์ต

## โปรไฟล์ dev + dev gateway (--dev)

ใช้โปรไฟล์ dev เพื่อแยกสถานะและสร้างสภาพแวดล้อมที่ปลอดภัยและทิ้งได้สำหรับการดีบัก มีแฟล็ก `--dev` **สอง** แบบ: มีแฟล็ก `--dev` **สอง** ตัว:

- **`--dev` (โปรไฟล์) แบบ global:** แยกสถานะไว้ใต้ `~/.openclaw-dev` และ
  ตั้งค่าพอร์ต gateway เริ่มต้นเป็น `19001` (พอร์ตที่ได้จากการคำนวณจะเลื่อนไปตามนั้น)
- **`gateway --dev`: บอก Gateway ให้สร้างคอนฟิกเริ่มต้น + เวิร์กสเปซอัตโนมัติ** เมื่อยังไม่มี (และข้าม BOOTSTRAP.md)

โฟลว์ที่แนะนำ (โปรไฟล์ dev + dev bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

หากคุณยังไม่มีการติดตั้งแบบ global ให้รัน CLI ผ่าน `pnpm openclaw ...`.

สิ่งที่ทำ:

1. **การแยกโปรไฟล์** (`--dev` แบบ global)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (เบราว์เซอร์/แคนวาสจะเลื่อนตาม)

2. **Dev bootstrap** (`gateway --dev`)
   - เขียนคอนฟิกขั้นต่ำหากยังไม่มี (`gateway.mode=local`, bind loopback)
   - ตั้งค่า `agent.workspace` เป็นเวิร์กสเปซ dev
   - ตั้งค่า `agent.skipBootstrap=true` (ไม่ใช้ BOOTSTRAP.md)
   - เตรียมไฟล์เวิร์กสเปซหากยังไม่มี:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - ตัวตนเริ่มต้น: **C3‑PO** (โปรโตคอลดรอยด์)
   - ข้ามผู้ให้บริการช่องทางในโหมด dev (`OPENCLAW_SKIP_CHANNELS=1`)

โฟลว์รีเซ็ต (เริ่มใหม่ทั้งหมด):

```bash
pnpm gateway:dev:reset
```

หมายเหตุ: `--dev` เป็นแฟล็กโปรไฟล์แบบ **global** และอาจถูกตัวรันบางตัวกลืนหาย
หากต้องการระบุให้ชัดเจน ให้ใช้รูปแบบ env var:
หากต้องการระบุให้ชัด ให้ใช้รูปแบบตัวแปรสภาพแวดล้อม:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` จะล้างคอนฟิก ข้อมูลรับรอง เซสชัน และเวิร์กสเปซ dev (โดยใช้
`trash` ไม่ใช่ `rm`), จากนั้นสร้างชุด dev เริ่มต้นใหม่

เคล็ดลับ: หากมี gateway ที่ไม่ใช่ dev รันอยู่แล้ว (launchd/systemd) ให้หยุดก่อน:

```bash
openclaw gateway stop
```

## การบันทึกสตรีมดิบ (OpenClaw)

OpenClaw สามารถบันทึก **สตรีมผู้ช่วยดิบ** ก่อนการกรอง/จัดรูปแบบใดๆ
นี่เป็นวิธีที่ดีที่สุดในการดูว่าเหตุผลมาถึงในรูปข้อความธรรมดาแบบเดลตา
(หรือมาเป็นบล็อกความคิดแยกต่างหาก)
นี่เป็นวิธีที่ดีที่สุดในการดูว่าการให้เหตุผลเข้ามาเป็นเดลตาข้อความธรรมดา
(หรือเป็นบล็อกการคิดแยกต่างหาก)

เปิดใช้งานผ่าน CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

ตัวเลือกการ override พาธ:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

env var ที่เทียบเท่า:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

ไฟล์เริ่มต้น:

`~/.openclaw/logs/raw-stream.jsonl`

## การบันทึกชังก์ดิบ (pi-mono)

เพื่อจับ **ชังก์ที่เข้ากันได้กับ OpenAI แบบดิบ** ก่อนถูกแยกเป็นบล็อก
pi-mono มีตัวบันทึกแยกต่างหาก:

```bash
PI_RAW_STREAM=1
```

พาธทางเลือก:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

ไฟล์เริ่มต้น:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> หมายเหตุ: สิ่งนี้จะถูกปล่อยออกมาเฉพาะโดยโปรเซสที่ใช้ผู้ให้บริการ
> `openai-completions` ของ pi-mono เท่านั้น

## หมายเหตุด้านความปลอดภัย

- ล็อกสตรีมดิบอาจมีพรอมป์เต็ม เอาต์พุตเครื่องมือ และข้อมูลผู้ใช้
- เก็บล็อกไว้ในเครื่องและลบทิ้งหลังดีบักเสร็จ
- หากต้องแชร์ล็อก ให้ลบความลับและข้อมูลส่วนบุคคล (PII) ก่อน
