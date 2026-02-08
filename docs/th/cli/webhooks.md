---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw webhooks` (เครื่องมือช่วยเว็บฮุค + Gmail Pub/Sub)"
read_when:
  - คุณต้องการเชื่อมต่ออีเวนต์ Gmail Pub/Sub เข้ากับ OpenClaw
  - คุณต้องการคำสั่งเครื่องมือช่วยเว็บฮุค
title: "เว็บฮุค"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:58Z
---

# `openclaw webhooks`

เครื่องมือช่วยและการผสานรวมเว็บฮุค (Gmail Pub/Sub, เครื่องมือช่วยเว็บฮุค)

เกี่ยวข้อง:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

ดูเอกสาร [Gmail Pub/Sub](/automation/gmail-pubsub) สำหรับรายละเอียด
