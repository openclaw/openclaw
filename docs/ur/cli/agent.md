---
summary: "CLI حوالہ برائے `openclaw agent` (Gateway کے ذریعے ایک ایجنٹ ٹرن بھیجیں)"
read_when:
  - آپ اسکرپٹس سے ایک ایجنٹ ٹرن چلانا چاہتے ہیں (اختیاری طور پر جواب پہنچانا)
title: "ایجنٹ"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:56Z
---

# `openclaw agent`

Gateway کے ذریعے ایک ایجنٹ ٹرن چلائیں (ایمبیڈڈ کے لیے `--local` استعمال کریں)۔
کنفیگر شدہ ایجنٹ کو براہِ راست ہدف بنانے کے لیے `--agent <id>` استعمال کریں۔

متعلقہ:

- ایجنٹ سینڈ ٹول: [Agent send](/tools/agent-send)

## مثالیں

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
