---
summary: "เอกสารอ้างอิงCLIสำหรับ`openclaw tui`(เทอร์มินัลUIที่เชื่อมต่อกับGateway)"
read_when:
  - คุณต้องการเทอร์มินัลUIสำหรับGateway(เหมาะกับการใช้งานระยะไกล)
  - คุณต้องการส่งผ่านurl/token/sessionจากสคริปต์
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:57Z
---

# `openclaw tui`

เปิดเทอร์มินัลUIที่เชื่อมต่อกับGateway

เกี่ยวข้อง:

- คู่มือTUI: [TUI](/web/tui)

## ตัวอย่าง

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
