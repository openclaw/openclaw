---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw agent` (ส่งหนึ่งรอบของเอเจนต์ผ่านGateway)"
read_when:
  - คุณต้องการรันหนึ่งรอบของเอเจนต์จากสคริปต์(เลือกได้ว่าจะส่งมอบการตอบกลับหรือไม่)
title: "เอเจนต์"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:53Z
---

# `openclaw agent`

รันหนึ่งรอบของเอเจนต์ผ่านGateway（เกตเวย์）(ใช้ `--local` สำหรับแบบฝังตัว)
ใช้ `--agent <id>` เพื่อกำหนดเป้าหมายไปยังเอเจนต์ที่ตั้งค่าไว้โดยตรง

เกี่ยวข้อง:

- เครื่องมือส่งเอเจนต์: [ส่งเอเจนต์](/tools/agent-send)

## ตัวอย่าง

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
