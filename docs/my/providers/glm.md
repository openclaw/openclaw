---
summary: "GLM မော်ဒယ်မိသားစု အကျဉ်းချုပ် + OpenClaw တွင် အသုံးပြုနည်း"
read_when:
  - OpenClaw တွင် GLM မော်ဒယ်များကို အသုံးပြုလိုသောအခါ
  - မော်ဒယ် အမည်ပေးပုံစံနှင့် တပ်ဆင်မှုကို လိုအပ်သောအခါ
title: "GLM မော်ဒယ်များ"
---

# GLM မော်ဒယ်များ

GLM သည် ကုမ္ပဏီမဟုတ်ဘဲ **model family** တစ်ခုဖြစ်ပြီး Z.AI platform မှတဆင့် ရရှိနိုင်ပါသည်။ OpenClaw တွင် GLM models များကို `zai` provider နှင့် `zai/glm-4.7` ကဲ့သို့သော model IDs များဖြင့် အသုံးပြုပါသည်။

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
