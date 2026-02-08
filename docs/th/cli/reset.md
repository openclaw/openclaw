---
summary: "เอกสารอ้างอิงCLIสำหรับ`openclaw reset`(รีเซ็ตคอนฟิก/สถานะภายในเครื่อง)"
read_when:
  - คุณต้องการล้างสถานะภายในเครื่องโดยยังคงติดตั้งCLIไว้
  - คุณต้องการดูแบบdry-runว่ามีอะไรบ้างที่จะถูกลบ
title: "รีเซ็ต"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:56Z
---

# `openclaw reset`

รีเซ็ตคอนฟิก/สถานะภายในเครื่อง(ยังคงติดตั้งCLIไว้)

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
