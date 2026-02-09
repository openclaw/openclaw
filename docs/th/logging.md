---
summary: "ภาพรวมการบันทึกล็อก: ไฟล์ล็อก เอาต์พุตคอนโซล การ tail ผ่าน CLI และ Control UI"
read_when:
  - คุณต้องการภาพรวมการบันทึกล็อกที่เข้าใจง่ายสำหรับผู้เริ่มต้น
  - คุณต้องการกำหนดค่าระดับหรือรูปแบบของล็อก
  - คุณกำลังแก้ไขปัญหาและต้องการค้นหาล็อกอย่างรวดเร็ว
title: "การบันทึกล็อก"
---

# การบันทึกล็อก

OpenClaw บันทึกล็อกไว้สองตำแหน่ง:

- **ไฟล์ล็อก** (JSON lines) ที่เขียนโดย Gateway
- **เอาต์พุตคอนโซล** ที่แสดงในเทอร์มินัลและ Control UI

หน้านี้อธิบายว่าล็อกอยู่ที่ไหน วิธีอ่านล็อก และวิธีกำหนดค่าระดับและรูปแบบของล็อก

## ตำแหน่งที่เก็บล็อก

ตามค่าเริ่มต้น Gateway จะเขียนไฟล์ล็อกแบบหมุนเวียนไว้ที่:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

วันที่จะอ้างอิงตามเขตเวลาท้องถิ่นของโฮสต์Gateway

คุณสามารถเปลี่ยนค่านี้ได้ใน `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## วิธีอ่านล็อก

### CLI: tail แบบสด (แนะนำ)

ใช้ CLI เพื่อ tail ไฟล์ล็อกของ Gateway ผ่าน RPC:

```bash
openclaw logs --follow
```

โหมดเอาต์พุต:

- **เซสชัน TTY**: ล็อกที่จัดรูปแบบสวยงาม มีสี และมีโครงสร้าง
- **เซสชันที่ไม่ใช่ TTY**: ข้อความธรรมดา
- `--json`: JSON คั่นด้วยบรรทัด (หนึ่งเหตุการณ์ล็อกต่อหนึ่งบรรทัด)
- `--plain`: บังคับใช้ข้อความธรรมดาในเซสชัน TTY
- `--no-color`: ปิดสี ANSI

ในโหมด JSON CLI จะส่งออบเจ็กต์ที่ติดแท็ก `type`:

- `meta`: เมตาดาต้าของสตรีม (ไฟล์ เคอร์เซอร์ ขนาด)
- `log`: รายการล็อกที่ถูกพาร์สแล้ว
- `notice`: คำใบ้เกี่ยวกับการตัดทอน/การหมุนไฟล์
- `raw`: บรรทัดล็อกที่ยังไม่ได้พาร์ส

หากไม่สามารถเข้าถึง Gateway ได้ CLI จะแสดงคำแนะนำสั้นๆให้รัน:

```bash
openclaw doctor
```

### Control UI (เว็บ)

แท็บ **Logs** ใน Control UI จะ tail ไฟล์เดียวกันโดยใช้ `logs.tail` ดูวิธีเปิดได้ที่ [/web/control-ui](/web/control-ui)
ดู [/web/control-ui](/web/control-ui) สำหรับวิธีเปิด

### ล็อกเฉพาะช่องทาง

หากต้องการกรองกิจกรรมของช่องทาง (WhatsApp/Telegram/ฯลฯ) ให้ใช้:

```bash
openclaw channels logs --channel whatsapp
```

## รูปแบบล็อก

### ไฟล์ล็อก (JSONL)

แต่ละบรรทัดในไฟล์ล็อกคือออบเจ็กต์ JSON หนึ่งรายการ แต่ละบรรทัดในไฟล์ล็อกเป็นออบเจ็กต์ JSON CLI และ Control UI จะพาร์สรายการเหล่านี้เพื่อแสดงผลลัพธ์แบบมีโครงสร้าง (เวลา ระดับ ระบบย่อย ข้อความ)

### เอาต์พุตคอนโซล

ล็อกคอนโซลเป็นแบบ **รับรู้ TTY** และจัดรูปแบบเพื่อให้อ่านง่าย:

- คำนำหน้าระบบย่อย (เช่น `gateway/channels/whatsapp`)
- การไล่สีตามระดับ (info/warn/error)
- โหมดกระชับหรือโหมด JSON (ไม่บังคับ)

การจัดรูปแบบคอนโซลถูกควบคุมโดย `logging.consoleStyle`

## การกำหนดค่าการบันทึกล็อก

การกำหนดค่าล็อกทั้งหมดอยู่ภายใต้ `logging` ในไฟล์ `~/.openclaw/openclaw.json`

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### ระดับล็อก

- `logging.level`: ระดับของ **ไฟล์ล็อก** (JSONL)
- `logging.consoleLevel`: ระดับความละเอียดของ **คอนโซล**

`--verbose` มีผลกับเอาต์พุตคอนโซลเท่านั้น ไม่ได้เปลี่ยนระดับของไฟล์ล็อก

### สไตล์คอนโซล

`logging.consoleStyle`:

- `pretty`: เป็นมิตรต่อการอ่าน มีสี และมีเวลา
- `compact`: เอาต์พุตกระชับ (เหมาะสำหรับเซสชันยาว)
- `json`: JSON ต่อบรรทัด (สำหรับตัวประมวลผลล็อก)

### การปิดบังข้อมูล

สรุปของเครื่องมือสามารถปกปิดโทเคนที่อ่อนไหวก่อนแสดงบนคอนโซล:

- `logging.redactSensitive`: `off` | `tools` (ค่าเริ่มต้น: `tools`)
- `logging.redactPatterns`: รายการสตริง regex เพื่อแทนที่ชุดค่าเริ่มต้น

การปกปิดมีผลกับ **เอาต์พุตคอนโซลเท่านั้น** และไม่เปลี่ยนไฟล์ล็อก

## Diagnostics + OpenTelemetry

Diagnostics คือเหตุการณ์แบบมีโครงสร้างและอ่านได้ด้วยเครื่อง สำหรับการรันโมเดล **และ** เทเลเมทรีของการไหลของข้อความ (webhooks การเข้าคิว สถานะเซสชัน) โดย **ไม่ได้** ใช้แทนล็อก แต่มีไว้เพื่อป้อนข้อมูลให้เมตริก ทรซ และตัวส่งออกอื่นๆ มัน **ไม่ได้**
มาแทนที่ล็อก; มันมีไว้เพื่อป้อนข้อมูลให้กับเมตริก เทรซ และเอ็กซ์พอร์ตเตอร์อื่น ๆ

เหตุการณ์ Diagnostics จะถูกส่งภายในโปรเซส แต่ตัวส่งออกจะเชื่อมต่อก็ต่อเมื่อเปิดใช้งาน diagnostics และปลั๊กอินของตัวส่งออก

### OpenTelemetry เทียบกับ OTLP

- **OpenTelemetry (OTel)**: โมเดลข้อมูลและ SDK สำหรับทรซ เมตริก และล็อก
- **OTLP**: โปรโตคอลบนสายสำหรับส่งออกข้อมูล OTel ไปยังคอลเลกเตอร์/แบ็กเอนด์
- OpenClaw ส่งออกผ่าน **OTLP/HTTP (protobuf)** ในปัจจุบัน

### สัญญาณที่ส่งออก

- **Metrics**: ตัวนับและฮิสโตแกรม (การใช้โทเคน การไหลของข้อความ การเข้าคิว)
- **Traces**: สแปนสำหรับการใช้โมเดลและการประมวลผล webhook/ข้อความ
- **Logs**: ส่งออกผ่าน OTLP เมื่อเปิด `diagnostics.otel.logs` ปริมาณล็อกอาจสูง ควรคำนึงถึง `logging.level` และตัวกรองของตัวส่งออก 1. บันทึก
  ปริมาณอาจสูงได้ โปรดคำนึงถึง `logging.level` และตัวกรองของ exporter

### แคตตาล็อกเหตุการณ์ Diagnostics

การใช้โมเดล:

- `model.usage`: โทเคน ค่าใช้จ่าย ระยะเวลา บริบท ผู้ให้บริการ/โมเดล/ช่องทาง ไอดีเซสชัน

การไหลของข้อความ:

- `webhook.received`: webhook เข้าในแต่ละช่องทาง
- `webhook.processed`: webhook ที่ถูกจัดการพร้อมระยะเวลา
- `webhook.error`: ข้อผิดพลาดของตัวจัดการ webhook
- `message.queued`: ข้อความถูกเข้าคิวเพื่อประมวลผล
- `message.processed`: ผลลัพธ์ ระยะเวลา และข้อผิดพลาด(ถ้ามี)

คิวและเซสชัน:

- `queue.lane.enqueue`: การเข้าคิว lane ของคำสั่งและความลึก
- `queue.lane.dequeue`: การดึงออกจากคิวและเวลารอ
- `session.state`: การเปลี่ยนสถานะเซสชันและเหตุผล
- `session.stuck`: คำเตือนเซสชันค้างและอายุ
- `run.attempt`: เมตาดาต้าการลองรัน/การพยายาม
- `diagnostic.heartbeat`: ตัวนับรวม (webhooks/คิว/เซสชัน)

### เปิดใช้งาน diagnostics (ไม่มีตัวส่งออก)

ใช้กรณีนี้หากต้องการให้เหตุการณ์ diagnostics พร้อมใช้งานสำหรับปลั๊กอินหรือ sink แบบกำหนดเอง:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### แฟล็ก diagnostics (ล็อกแบบเจาะจง)

ใช้แฟล็กเพื่อเปิดล็อกดีบักเพิ่มเติมแบบเจาะจงโดยไม่ต้องเพิ่ม `logging.level` แฟล็กไม่สนใจตัวพิมพ์เล็กใหญ่และรองรับ wildcard (เช่น `telegram.*` หรือ `*`)
2. แฟล็กไม่แยกตัวพิมพ์เล็ก‑ใหญ่และรองรับไวลด์การ์ด (เช่น `telegram.*` หรือ `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

การ override ผ่าน env (ครั้งเดียว):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

หมายเหตุ:

- ล็อกจากแฟล็กจะไปที่ไฟล์ล็อกมาตรฐาน (เช่นเดียวกับ `logging.file`)
- เอาต์พุตยังคงถูกปกปิดตาม `logging.redactSensitive`
- คู่มือฉบับเต็ม: [/diagnostics/flags](/diagnostics/flags)

### ส่งออกไปยัง OpenTelemetry

Diagnostics สามารถส่งออกผ่านปลั๊กอิน `diagnostics-otel` (OTLP/HTTP) ใช้ได้กับคอลเลกเตอร์/แบ็กเอนด์ OpenTelemetry ใดๆที่รับ OTLP/HTTP 3. สิ่งนี้
ทำงานได้กับ OpenTelemetry collector/backend ใด ๆ ที่รองรับ OTLP/HTTP

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

หมายเหตุ:

- คุณสามารถเปิดปลั๊กอินด้วย `openclaw plugins enable diagnostics-otel` ได้เช่นกัน
- `protocol` รองรับเฉพาะ `http/protobuf` ในปัจจุบัน `grpc` จะถูกละเลย 4. `grpc` จะถูกละเว้น
- เมตริกรวมถึงการใช้โทเคน ค่าใช้จ่าย ขนาดบริบท ระยะเวลาการรัน และตัวนับ/ฮิสโตแกรมของการไหลของข้อความ (webhooks การเข้าคิว สถานะเซสชัน ความลึก/เวลารอของคิว)
- 5. สามารถเปิด/ปิด traces/metrics ได้ด้วย `traces` / `metrics` (ค่าเริ่มต้น: เปิด) Traces/metrics สามารถเปิดปิดได้ด้วย `traces` / `metrics` (ค่าเริ่มต้น: เปิด) Traces รวมสแปนการใช้โมเดลและสแปนการประมวลผล webhook/ข้อความเมื่อเปิดใช้งาน
- ตั้งค่า `headers` เมื่อคอลเลกเตอร์ของคุณต้องการการยืนยันตัวตน
- รองรับตัวแปรสภาพแวดล้อม: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`

### เมตริกที่ส่งออก (ชื่อและชนิด)

การใช้โมเดล:

- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

การไหลของข้อความ:

- `openclaw.webhook.received` (counter, attrs: `openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.error` (counter, attrs: `openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`, `openclaw.webhook`)
- `openclaw.message.queued` (counter, attrs: `openclaw.channel`, `openclaw.source`)
- `openclaw.message.processed` (counter, attrs: `openclaw.channel`, `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`, `openclaw.outcome`)

คิวและเซสชัน:

- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` หรือ `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)

### สแปนที่ส่งออก (ชื่อและแอตทริบิวต์หลัก)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`, `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`, `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`, `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`, `openclaw.sessionKey`, `openclaw.sessionId`

### 6. การสุ่มตัวอย่าง + การฟลัช

- การสุ่มตัวอย่างทรซ: `diagnostics.otel.sampleRate` (0.0–1.0 เฉพาะ root spans)
- ช่วงเวลาส่งออกเมตริก: `diagnostics.otel.flushIntervalMs` (ขั้นต่ำ 1000ms)

### หมายเหตุเกี่ยวกับโปรโตคอล

- สามารถตั้งค่า endpoint ของ OTLP/HTTP ได้ผ่าน `diagnostics.otel.endpoint` หรือ `OTEL_EXPORTER_OTLP_ENDPOINT`
- หาก endpoint มี `/v1/traces` หรือ `/v1/metrics` อยู่แล้ว จะใช้งานตามนั้น
- หาก endpoint มี `/v1/logs` อยู่แล้ว จะใช้สำหรับล็อกตามนั้น
- `diagnostics.otel.logs` เปิดการส่งออก OTLP log สำหรับเอาต์พุตล็อกหลัก

### พฤติกรรมการส่งออกล็อก

- ล็อก OTLP ใช้เรคอร์ดแบบมีโครงสร้างเดียวกับที่เขียนลง `logging.file`
- 7. เคารพ `logging.level` (ระดับบันทึกไฟล์) เคารพ `logging.level` (ระดับไฟล์ล็อก) การปกปิดของคอนโซล **ไม่มีผล** กับล็อก OTLP
- ระบบที่มีปริมาณสูงควรใช้การสุ่มตัวอย่าง/การกรองที่คอลเลกเตอร์ OTLP

## เคล็ดลับการแก้ไขปัญหา

- **เข้าถึง Gateway ไม่ได้?** ให้รัน `openclaw doctor` ก่อน
- **ล็อกว่างเปล่า?** ตรวจสอบว่า Gateway กำลังรันอยู่และเขียนไปยังพาธไฟล์ที่ตั้งไว้ใน `logging.file`
- **ต้องการรายละเอียดมากขึ้น?** ตั้งค่า `logging.level` เป็น `debug` หรือ `trace` แล้วลองใหม่
