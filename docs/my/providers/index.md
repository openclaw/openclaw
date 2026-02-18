---
summary: "OpenClaw မှ ပံ့ပိုးထားသော မော်ဒယ် ပံ့ပိုးသူများ (LLMs)"
read_when:
  - မော်ဒယ် ပံ့ပိုးသူကို ရွေးချယ်လိုသောအခါ
  - ပံ့ပိုးထားသော LLM backend များ၏ အကျဉ်းချုပ်ကို အမြန်ကြည့်လိုသောအခါ
title: "မော်ဒယ် ပံ့ပိုးသူများ"
---

# မော်ဒယ် ပံ့ပိုးသူများ

OpenClaw သည် LLM providers များစွာကို အသုံးပြုနိုင်ပါသည်။ Provider တစ်ခုကို ရွေးချယ်၍ authenticate လုပ်ပြီး default model ကို `provider/model` အဖြစ် သတ်မှတ်ပါ။

Chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.) ကို ရှာနေပါသလား? [Channels](/channels) ကို ကြည့်ပါ။

## အထူးအလေးပေးချက်: Venice (Venice AI)

Venice သည် ကိုယ်ရေးကိုယ်တာကို ဦးစားပေးသော inference အတွက် ကျွန်ုပ်တို့ အကြံပြုထားသော Venice AI setup ဖြစ်ပြီး ခက်ခဲသော လုပ်ငန်းများအတွက် Opus ကို အသုံးပြုနိုင်သော ရွေးချယ်မှု ပါရှိသည်။

- မူလသတ်မှတ်ချက်: `venice/llama-3.3-70b`
- စုစုပေါင်းအကောင်းဆုံး: `venice/claude-opus-45` (Opus သည် အင်အားအကောင်းဆုံးအဖြစ် ဆက်လက်တည်ရှိနေသည်)

[Venice AI](/providers/venice) ကို ကြည့်ပါ။

## အမြန်စတင်ရန်

1. ပံ့ပိုးသူနှင့် အထောက်အထားပြုလုပ်ပါ (အများအားဖြင့် `openclaw onboard` မှတဆင့်)။
2. မူလ မော်ဒယ်ကို သတ်မှတ်ပါ —

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## ပံ့ပိုးသူ စာရွက်စာတမ်းများ

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, ကိုယ်ရေးကိုယ်တာကို ဦးစားပေး)](/providers/venice)
- [Ollama (local models)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## အသံပြောင်းရေး ပံ့ပိုးသူများ

- [Deepgram (audio transcription)](/providers/deepgram)

## လူထုအခြေပြု ကိရိယာများ

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro စာရင်းသွင်းမှုကို OpenAI နှင့် ကိုက်ညီသော API endpoint အဖြစ် အသုံးပြုနိုင်သည်

Provider catalog အပြည့်အစုံ (xAI, Groq, Mistral, etc.) အတွက် နှင့် advanced configuration များအတွက် [Model providers](/concepts/model-providers) ကို ကြည့်ပါ။
