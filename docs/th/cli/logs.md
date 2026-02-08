---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw logs` (ติดตามล็อกไฟล์ของGateway（เกตเวย์）ผ่านRPC)"
read_when:
  - คุณต้องการติดตามล็อกของGateway（เกตเวย์）จากระยะไกล(โดยไม่ใช้SSH)
  - คุณต้องการบรรทัดล็อกแบบJSONสำหรับเครื่องมือ
title: "logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:55Z
---

# `openclaw logs`

ติดตามล็อกไฟล์ของGateway（เกตเวย์）ผ่านRPC(ทำงานในโหมดremote)

เกี่ยวข้อง:

- ภาพรวมการบันทึกล็อก: [Logging](/logging)

## ตัวอย่าง

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
