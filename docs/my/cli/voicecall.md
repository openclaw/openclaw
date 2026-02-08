---
summary: "`openclaw voicecall` အတွက် CLI ကိုးကားချက် (voice-call plugin ၏ အမိန့်မျက်နှာပြင်)"
read_when:
  - voice-call plugin ကို အသုံးပြုနေပြီး CLI ဝင်ပေါက်များကို သိလိုသောအခါ
  - `voicecall call|continue|status|tail|expose` အတွက် အမြန်နမူနာများကို လိုချင်သောအခါ
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:08Z
---

# `openclaw voicecall`

`voicecall` သည် plugin မှ ပံ့ပိုးထားသော အမိန့်တစ်ခု ဖြစ်သည်။ voice-call plugin ကို ထည့်သွင်းပြီး အလုပ်လုပ်အောင် ပြုလုပ်ထားမှသာ ပေါ်လာပါသည်။

အဓိက စာရွက်စာတမ်း:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Webhooks ကို ဖော်ထုတ်ခြင်း (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

လုံခြုံရေး သတိပေးချက်: webhook endpoint ကို ယုံကြည်စိတ်ချရသော ကွန်ယက်များထံသို့သာ ဖော်ထုတ်ပါ။ ဖြစ်နိုင်ပါက Funnel ထက် Tailscale Serve ကို ဦးစားပေး အသုံးပြုပါ။
