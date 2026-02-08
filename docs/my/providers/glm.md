---
summary: "GLM မော်ဒယ်မိသားစု အကျဉ်းချုပ် + OpenClaw တွင် အသုံးပြုနည်း"
read_when:
  - OpenClaw တွင် GLM မော်ဒယ်များကို အသုံးပြုလိုသောအခါ
  - မော်ဒယ် အမည်ပေးပုံစံနှင့် တပ်ဆင်မှုကို လိုအပ်သောအခါ
title: "GLM မော်ဒယ်များ"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:42Z
---

# GLM မော်ဒယ်များ

GLM သည် **မော်ဒယ်မိသားစု** (ကုမ္ပဏီမဟုတ်ပါ) ဖြစ်ပြီး Z.AI ပလက်ဖောင်းမှတဆင့် ရရှိနိုင်ပါသည်။ OpenClaw တွင် GLM
မော်ဒယ်များကို `zai` provider နှင့် `zai/glm-4.7` ကဲ့သို့သော မော်ဒယ် ID များဖြင့် ဝင်ရောက်အသုံးပြုပါသည်။

## CLI Setup

```bash
openclaw onboard --auth-choice zai-api-key
```

## Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## မှတ်ချက်များ

- GLM ဗားရှင်းများနှင့် ရရှိနိုင်မှုသည် ပြောင်းလဲနိုင်ပါသည်; နောက်ဆုံးအချက်အလက်များအတွက် Z.AI ၏ စာတမ်းများကို စစ်ဆေးပါ။
- ဥပမာ မော်ဒယ် ID များတွင် `glm-4.7` နှင့် `glm-4.6` တို့ ပါဝင်ပါသည်။
- Provider အသေးစိတ်အတွက် [/providers/zai](/providers/zai) ကို ကြည့်ပါ။
