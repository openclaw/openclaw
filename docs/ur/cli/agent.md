---
summary: "CLI حوالہ برائے `openclaw agent` (Gateway کے ذریعے ایک ایجنٹ ٹرن بھیجیں)"
read_when:
  - آپ اسکرپٹس سے ایک ایجنٹ ٹرن چلانا چاہتے ہیں (اختیاری طور پر جواب پہنچانا)
title: "ایجنٹ"
---

# `openclaw agent`

گیٹ وے کے ذریعے ایک ایجنٹ ٹرن چلائیں (ایمبیڈڈ کے لیے `--local` استعمال کریں)۔
براہِ راست ترتیب دیے گئے ایجنٹ کو ہدف بنانے کے لیے `--agent <id>` استعمال کریں۔

متعلقہ:

- ایجنٹ سینڈ ٹول: [Agent send](/tools/agent-send)

## مثالیں

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
