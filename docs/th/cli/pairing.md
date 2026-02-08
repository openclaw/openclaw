---
summary: "เอกสารอ้างอิงCLIสำหรับ`openclaw pairing`(อนุมัติ/แสดงรายการคำขอการจับคู่)"
read_when:
  - คุณใช้DMsโหมดการจับคู่และจำเป็นต้องอนุมัติผู้ส่ง
title: "การจับคู่"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:59Z
---

# `openclaw pairing`

อนุมัติหรือตรวจสอบคำขอการจับคู่DM(สำหรับช่องทางที่รองรับการจับคู่)

เกี่ยวข้อง:

- โฟลว์การจับคู่: [การจับคู่](/channels/pairing)

## คำสั่ง

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
