---
summary: "OpenClaw ဖြင့် Z.AI (GLM မော်ဒယ်များ) ကို အသုံးပြုပါ"
read_when:
  - OpenClaw တွင် Z.AI / GLM မော်ဒယ်များကို အသုံးပြုလိုပါက
  - ရိုးရှင်းသော ZAI_API_KEY တပ်ဆင်မှု လိုအပ်ပါက
title: "Z.AI"
x-i18n:
  source_path: providers/zai.md
  source_hash: 2c24bbad86cf86c3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:44Z
---

# Z.AI

Z.AI သည် **GLM** မော်ဒယ်များအတွက် API ပလက်ဖောင်း ဖြစ်သည်။ GLM အတွက် REST API များကို ပံ့ပိုးပေးပြီး အတည်ပြုရန်အတွက် API key များကို အသုံးပြုသည်။
Z.AI console တွင် သင့် API key ကို ဖန်တီးပါ။ OpenClaw သည် Z.AI API key ဖြင့် `zai` provider ကို အသုံးပြုသည်။

## CLI setup

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notes

- GLM မော်ဒယ်များကို `zai/<model>` အဖြစ် ရရှိနိုင်သည် (ဥပမာ: `zai/glm-4.7`)။
- မော်ဒယ် မိသားစု အကျဉ်းချုပ်အတွက် [/providers/glm](/providers/glm) ကို ကြည့်ပါ။
- Z.AI သည် သင့် API key ဖြင့် Bearer auth ကို အသုံးပြုသည်။
