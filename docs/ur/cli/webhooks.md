---
summary: "CLI کے لیے `openclaw webhooks` کا حوالہ (ویب ہُک معاونین + Gmail Pub/Sub)"
read_when:
  - آپ Gmail Pub/Sub واقعات کو OpenClaw میں وائر کرنا چاہتے ہیں
  - آپ ویب ہُک معاون کمانڈز چاہتے ہیں
title: "ویب ہُکس"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:01Z
---

# `openclaw webhooks`

ویب ہُک معاونین اور انضمام (Gmail Pub/Sub، ویب ہُک معاونین)۔

متعلقہ:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

تفصیلات کے لیے [Gmail Pub/Sub دستاویزات](/automation/gmail-pubsub) دیکھیں۔
