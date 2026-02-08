---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw health` (เอ็นด์พอยต์ตรวจสุขภาพของGatewayผ่านRPC)"
read_when:
  - คุณต้องการตรวจสอบสถานะสุขภาพของGateway（เกตเวย์）ที่กำลังทำงานอย่างรวดเร็ว
title: "สุขภาพ"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:57Z
---

# `openclaw health`

ดึงข้อมูลสุขภาพจากGateway（เกตเวย์）ที่กำลังทำงานอยู่

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

หมายเหตุ:

- `--verbose` จะรันโพรบแบบสดและพิมพ์เวลาแยกตามบัญชีเมื่อมีการกำหนดค่าหลายบัญชี
- เอาต์พุตจะรวมสโตร์เซสชันต่อเอเจนต์เมื่อมีการกำหนดค่าเอเจนต์หลายตัว
