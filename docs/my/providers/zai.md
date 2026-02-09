---
summary: "OpenClaw ဖြင့် Z.AI (GLM မော်ဒယ်များ) ကို အသုံးပြုပါ"
read_when:
  - OpenClaw တွင် Z.AI / GLM မော်ဒယ်များကို အသုံးပြုလိုပါက
  - ရိုးရှင်းသော ZAI_API_KEY တပ်ဆင်မှု လိုအပ်ပါက
title: "Z.AI"
---

# Z.AI

Z.AI is the API platform for **GLM** models. It provides REST APIs for GLM and uses API keys
for authentication. Create your API key in the Z.AI console. OpenClaw uses the `zai` provider
with a Z.AI API key.

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
