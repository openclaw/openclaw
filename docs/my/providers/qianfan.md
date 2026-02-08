---
summary: "OpenClaw တွင် မော်ဒယ်များစွာကို ဝင်ရောက်အသုံးပြုရန် Qianfan ၏ ပေါင်းစည်းထားသော API ကို အသုံးပြုပါ"
read_when:
  - LLM များစွာအတွက် API key တစ်ခုတည်းကို အသုံးပြုလိုသောအခါ
  - Baidu Qianfan ကို တပ်ဆင်သတ်မှတ်ရန် လမ်းညွှန်ချက်များ လိုအပ်သောအခါ
title: "Qianfan"
x-i18n:
  source_path: providers/qianfan.md
  source_hash: 2ca710b422f190b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:46Z
---

# Qianfan ပံ့ပိုးသူ လမ်းညွှန်

Qianfan သည် Baidu ၏ MaaS ပလက်ဖောင်းဖြစ်ပြီး၊ **ပေါင်းစည်းထားသော API** တစ်ခုကို ပေးထားကာ endpoint တစ်ခုနှင့် API key တစ်ခုတည်းမှတဆင့် မော်ဒယ်များစွာသို့ တောင်းဆိုမှုများကို လမ်းကြောင်းညွှန်ပေးပါသည်။ ၎င်းသည် OpenAI-compatible ဖြစ်သောကြောင့် base URL ကို ပြောင်းလဲခြင်းဖြင့် OpenAI SDK အများစုကို အသုံးပြုနိုင်ပါသည်။

## ကြိုတင်လိုအပ်ချက်များ

1. Qianfan API ဝင်ရောက်ခွင့်ပါရှိသော Baidu Cloud အကောင့်တစ်ခု
2. Qianfan console မှ ရရှိသော API key တစ်ခု
3. သင့်စနစ်တွင် OpenClaw ကို ထည့်သွင်းတပ်ဆင်ပြီးသား ဖြစ်ရပါမည်

## API Key ကို ရယူခြင်း

1. [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey) သို့ သွားရောက်ပါ
2. အက်ပ်လီကေးရှင်း အသစ်တစ်ခု ဖန်တီးပါ သို့မဟုတ် ရှိပြီးသားကို ရွေးချယ်ပါ
3. API key တစ်ခုကို ထုတ်လုပ်ပါ (ဖော်မတ်: `bce-v3/ALTAK-...`)
4. OpenClaw တွင် အသုံးပြုရန် API key ကို ကူးယူထားပါ

## CLI တပ်ဆင်ခြင်း

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## ဆက်စပ် စာရွက်စာတမ်းများ

- [OpenClaw ဖွဲ့စည်းပြင်ဆင်ခြင်း](/gateway/configuration)
- [မော်ဒယ် ပံ့ပိုးသူများ](/concepts/model-providers)
- [အေးဂျင့် တပ်ဆင်ခြင်း](/concepts/agent)
- [Qianfan API စာရွက်စာတမ်းများ](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
