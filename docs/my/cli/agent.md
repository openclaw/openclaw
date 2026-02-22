---
summary: "Gateway（ဂိတ်ဝေး）မှတစ်ဆင့် `openclaw agent` အတွက် CLI ကိုးကားချက် (အေးဂျင့် တစ်ကြိမ်လှည့်ပတ်ကို ပို့ခြင်း)"
read_when:
  - စခရစ်များမှ အေးဂျင့် တစ်ကြိမ်လှည့်ပတ်ကို လည်ပတ်စေလိုသည့်အခါ (အဖြေကို ပို့ပေးရန် ရွေးချယ်နိုင်သည်)
title: "agent"
---

# `openclaw agent`

Gateway မှတစ်ဆင့် agent turn တစ်ကြိမ် chạy ပါ (`--local` ကို embedded အတွက် အသုံးပြုပါ)။
`--agent <id>` ကို အသုံးပြုပြီး configure လုပ်ထားသော agent ကို တိုက်ရိုက် target လုပ်ပါ။

ဆက်စပ်အရာများ:

- Agent send tool: [Agent send](/tools/agent-send)

## Examples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
