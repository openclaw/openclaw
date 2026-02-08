---
summary: "مرجع CLI لأمر `openclaw agent` (إرسال دورة وكيل واحدة عبر Gateway)"
read_when:
  - "تريد تشغيل دورة وكيل واحدة من خلال سكربتات (مع خيار تسليم الرد)"
title: "الوكيل"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:52Z
---

# `openclaw agent`

شغّل دورة وكيل عبر Gateway (استخدم `--local` للحالات المضمّنة).
استخدم `--agent <id>` لاستهداف وكيل مُهيّأ مباشرةً.

ذات صلة:

- أداة إرسال الوكيل: [Agent send](/tools/agent-send)

## أمثلة

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
