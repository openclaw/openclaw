---
summary: "Gateway（ဂိတ်ဝေး）မှတစ်ဆင့် `openclaw agent` အတွက် CLI ကိုးကားချက် (အေးဂျင့် တစ်ကြိမ်လှည့်ပတ်ကို ပို့ခြင်း)"
read_when:
  - စခရစ်များမှ အေးဂျင့် တစ်ကြိမ်လှည့်ပတ်ကို လည်ပတ်စေလိုသည့်အခါ (အဖြေကို ပို့ပေးရန် ရွေးချယ်နိုင်သည်)
title: "agent"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:53Z
---

# `openclaw agent`

Gateway（ဂိတ်ဝေး）မှတစ်ဆင့် အေးဂျင့် တစ်ကြိမ်လှည့်ပတ်ကို လည်ပတ်စေပါ (`--local` ကို embedded အတွက် အသုံးပြုပါ)။
ဖွဲ့စည်းပြင်ဆင်ထားသော အေးဂျင့်ကို တိုက်ရိုက် ဦးတည်ရန် `--agent <id>` ကို အသုံးပြုပါ။

ဆက်စပ်အရာများ:

- Agent send tool: [Agent send](/tools/agent-send)

## Examples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
