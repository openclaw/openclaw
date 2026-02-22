---
summary: "`openclaw voicecall` အတွက် CLI ကိုးကားချက် (voice-call plugin ၏ အမိန့်မျက်နှာပြင်)"
read_when:
  - voice-call plugin ကို အသုံးပြုနေပြီး CLI ဝင်ပေါက်များကို သိလိုသောအခါ
  - "`voicecall call|continue|status|tail|expose` အတွက် အမြန်နမူနာများကို လိုချင်သောအခါ"
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` သည် plugin မှ ပံ့ပိုးပေးထားသော command ဖြစ်ပါသည်။ Voice-call plugin ကို install လုပ်ပြီး enable လုပ်ထားမှသာ ပေါ်လာပါသည်။

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

Security မှတ်ချက်: webhook endpoint ကို ယုံကြည်ရသော network များသို့သာ ဖွင့်ပါ။ ဖြစ်နိုင်ပါက Funnel ထက် Tailscale Serve ကို ဦးစားပေးပါ။
