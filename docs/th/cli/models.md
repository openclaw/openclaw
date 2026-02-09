---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw models` (สถานะ/รายการ/ตั้งค่า/สแกน, นามแฝง, ฟอลแบ็ก, การยืนยันตัวตน)"
read_when:
  - คุณต้องการเปลี่ยนโมเดลเริ่มต้นหรือดูสถานะการยืนยันตัวตนของผู้ให้บริการ
  - คุณต้องการสแกนโมเดล/ผู้ให้บริการที่มีและดีบักโปรไฟล์การยืนยันตัวตน
title: "โมเดล"
---

# `openclaw models`

การค้นหาโมเดล การสแกน และการกำหนดค่า (โมเดลเริ่มต้น ฟอลแบ็ก โปรไฟล์การยืนยันตัวตน)

เกี่ยวข้อง:

- ผู้ให้บริการ+โมเดล: [Models](/providers/models)
- การตั้งค่าการยืนยันตัวตนของผู้ให้บริการ: [Getting started](/start/getting-started)

## คำสั่งที่ใช้บ่อย

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` แสดงค่าเริ่มต้น/ทางเลือกสำรองที่แก้ไขแล้ว พร้อมภาพรวมการยืนยันตัวตน
เมื่อมีสแนปช็อตการใช้งานของผู้ให้บริการ ส่วนสถานะ OAuth/โทเค็นจะรวมส่วนหัวการใช้งานของผู้ให้บริการ
เพิ่ม `--probe` เพื่อรันการตรวจสอบการยืนยันตัวตนแบบสดกับแต่ละโปรไฟล์ผู้ให้บริการที่ตั้งค่าไว้
การตรวจสอบเป็นคำขอจริง (อาจใช้โทเค็นและกระตุ้นข้อจำกัดอัตรา).
ใช้ `--agent <id>` เพื่อตรวจสอบสถานะโมเดล/การยืนยันตัวตนของเอเจนต์ที่ตั้งค่าไว้ เมื่อเว้นว่างไว้,
คำสั่งจะใช้ `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` หากตั้งค่าไว้ มิฉะนั้นจะใช้เอเจนต์เริ่มต้นที่ตั้งค่าไว้

หมายเหตุ:

- `models set <model-or-alias>` รับ `provider/model` หรือนามแฝง
- การอ้างอิงโมเดลจะถูกพาร์สโดยแยกที่ `/` **ครั้งแรก** ใช้ `provider/model` เมื่อพิมพ์ `/model <ref>` การอ้างอิงโมเดลจะถูกแยกโดยแบ่งที่ `/` ตัวแรก หากรหัสโมเดลมี `/` (สไตล์ OpenRouter) ให้ใส่คำนำหน้าผู้ให้บริการ (ตัวอย่าง: `openrouter/moonshotai/kimi-k2`)
- หากละผู้ให้บริการ OpenClaw จะถืออินพุตเป็นนามแฝงหรือโมเดลสำหรับ **ผู้ให้บริการเริ่มต้น** (ใช้ได้เฉพาะเมื่อไม่มี `/` ในรหัสโมเดล)

### `models status`

ตัวเลือก:

- `--json`
- `--plain`
- `--check` (ออกด้วยรหัส 1=หมดอายุ/ขาดหาย, 2=ใกล้หมดอายุ)
- `--probe` (ตรวจสอบแบบสดของโปรไฟล์การยืนยันตัวตนที่กำหนดค่าไว้)
- `--probe-provider <name>` (ตรวจสอบผู้ให้บริการหนึ่งราย)
- `--probe-profile <id>` (ทำซ้ำหรือระบุรหัสโปรไฟล์คั่นด้วยจุลภาค)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (รหัสเอเจนต์ที่กำหนดค่าไว้; แทนที่ `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## นามแฝง + ทางเลือกสำรอง

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## โปรไฟล์การยืนยันตัวตน

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` รันโฟลว์การยืนยันตัวตนของปลั๊กอินผู้ให้บริการ (OAuth/คีย์API) ใช้
`openclaw plugins list` เพื่อดูว่ามีผู้ให้บริการใดติดตั้งอยู่บ้าง ใช้
`openclaw plugins list` เพื่อดูว่ามีผู้ให้บริการใดติดตั้งอยู่

หมายเหตุ:

- `setup-token` จะถามค่าของ setup-token (สร้างได้ด้วย `claude setup-token` บนเครื่องใดก็ได้)
- `paste-token` รับสตริงโทเคนที่สร้างจากที่อื่นหรือจากระบบอัตโนมัติ
