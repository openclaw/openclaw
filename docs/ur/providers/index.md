---
summary: "OpenClaw کے ذریعے معاون ماڈل فراہم کنندگان (LLMs)"
read_when:
  - آپ ماڈل فراہم کنندہ منتخب کرنا چاہتے ہیں
  - آپ کو معاون LLM بیک اینڈز کا فوری جائزہ درکار ہے
title: "ماڈل فراہم کنندگان"
---

# ماڈل فراہم کنندگان

OpenClaw can use many LLM providers. Pick a provider, authenticate, then set the
default model as `provider/model`.

Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? See [Channels](/channels).

## نمایاں: Venice (Venice AI)

Venice ہماری تجویز کردہ Venice AI سیٹ اپ ہے جو پرائیویسی فرسٹ انفیرینس کے لیے ہے، اور مشکل کاموں کے لیے Opus استعمال کرنے کا اختیار فراہم کرتا ہے۔

- ڈیفالٹ: `venice/llama-3.3-70b`
- مجموعی طور پر بہترین: `venice/claude-opus-45` (Opus بدستور سب سے مضبوط ہے)

[Venice AI](/providers/venice) دیکھیں۔

## فوری آغاز

1. فراہم کنندہ کے ساتھ تصدیق کریں (عموماً `openclaw onboard` کے ذریعے)۔
2. ڈیفالٹ ماڈل سیٹ کریں:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## فراہم کنندہ کی دستاویزات

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
- [Venice (Venice AI، پرائیویسی پر مرکوز)](/providers/venice)
- [Ollama (لوکل ماڈلز)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## ٹرانسکرپشن فراہم کنندگان

- [Deepgram (آڈیو ٹرانسکرپشن)](/providers/deepgram)

## کمیونٹی ٹولز

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro سبسکرپشن کو OpenAI کے موافق API اینڈپوائنٹ کے طور پر استعمال کریں

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
