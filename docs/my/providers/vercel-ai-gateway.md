---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway တပ်ဆင်ခြင်း (auth + မော်ဒယ်ရွေးချယ်မှု)"
read_when:
  - OpenClaw နှင့် Vercel AI Gateway ကို အသုံးပြုလိုပါက
  - API key အတွက် env var သို့မဟုတ် CLI auth ရွေးချယ်မှုကို လိုအပ်ပါက
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) သည် endpoint တစ်ခုတည်းမှတဆင့် မော်ဒယ်များ အများအပြားကို ဝင်ရောက်အသုံးပြုနိုင်စေရန် ပေါင်းစည်းထားသော API တစ်ခုကို ပံ့ပိုးပေးပါသည်။

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages compatible

## အမြန်စတင်ရန်

1. API key ကို သတ်မှတ်ပါ (အကြံပြုချက် — Gateway အတွက် သိမ်းဆည်းထားပါ):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. မူလအသုံးပြုမည့် မော်ဒယ်ကို သတ်မှတ်ပါ:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## အပြန်အလှန်မလုပ်သော ဥပမာ

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## ပတ်ဝန်းကျင်ဆိုင်ရာ မှတ်ချက်

Gateway ကို daemon (launchd/systemd) အဖြစ် လည်ပတ်ပါက `AI_GATEWAY_API_KEY`
ကို ထို process မှ ဝင်ရောက်အသုံးပြုနိုင်စေရန် သေချာစေပါ (ဥပမာအားဖြင့် `~/.openclaw/.env` တွင် သို့မဟုတ်
`env.shellEnv` မှတဆင့်)။
