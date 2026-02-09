---
summary: "OpenClaw မှ ပံ့ပိုးထားသော မော်ဒယ် ပံ့ပိုးသူများ (LLMs)"
read_when:
  - မော်ဒယ် ပံ့ပိုးသူကို ရွေးချယ်လိုသောအခါ
  - LLM အတည်ပြုခြင်းနှင့် မော်ဒယ် ရွေးချယ်ခြင်းအတွက် အမြန်တပ်ဆင်နမူနာများ လိုအပ်သောအခါ
title: "Model Provider အမြန်စတင်လမ်းညွှန်"
---

# Model Providers

OpenClaw သည် LLM providers များစွာကို အသုံးပြုနိုင်ပါသည်။ တစ်ခုကို ရွေးချယ်၍ authenticate လုပ်ပြီး default model ကို `provider/model` အဖြစ် သတ်မှတ်ပါ။

## အထူးအကြံပြုချက်: Venice (Venice AI)

Venice သည် ကိုယ်ရေးအချက်အလက်ကို ဦးစားပေးသော inference အတွက် ကျွန်ုပ်တို့ အကြံပြုသော Venice AI တပ်ဆင်မှု ဖြစ်ပြီး အခက်ခဲဆုံး လုပ်ငန်းများအတွက် Opus ကို အသုံးပြုနိုင်သော ရွေးချယ်မှုလည်း ပါဝင်ပါသည်။

- မူလ: `venice/llama-3.3-70b`
- အလုံးစုံ အကောင်းဆုံး: `venice/claude-opus-45` (Opus သည် အားအကောင်းဆုံးအဖြစ် ဆက်လက် ရပ်တည်နေသည်)

[Venice AI](/providers/venice) ကို ကြည့်ရှုပါ။

## အမြန်စတင်ရန် (အဆင့် နှစ်ဆင့်)

1. ပံ့ပိုးသူနှင့် အတည်ပြုခြင်းကို ပြုလုပ်ပါ (ပုံမှန်အားဖြင့် `openclaw onboard` မှတစ်ဆင့်)။
2. မူလ မော်ဒယ်ကို သတ်မှတ်ပါ။

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## ပံ့ပိုးထားသော ပံ့ပိုးသူများ (စတင်အသုံးပြုရန် အစု)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

Provider catalog အပြည့်အစုံ (xAI, Groq, Mistral, etc.) အတွက် နှင့် advanced configuration များအတွက် [Model providers](/concepts/model-providers) ကို ကြည့်ပါ။
