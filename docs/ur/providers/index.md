---
summary: "OpenClaw کے ذریعے معاون ماڈل فراہم کنندگان (LLMs)"
read_when:
  - آپ ماڈل فراہم کنندہ منتخب کرنا چاہتے ہیں
  - آپ کو معاون LLM بیک اینڈز کا فوری جائزہ درکار ہے
title: "ماڈل فراہم کنندگان"
x-i18n:
  source_path: providers/index.md
  source_hash: af168e89983fab19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:32Z
---

# ماڈل فراہم کنندگان

OpenClaw متعدد LLM فراہم کنندگان استعمال کر سکتا ہے۔ کسی فراہم کنندہ کا انتخاب کریں، تصدیق کریں، پھر ڈیفالٹ ماڈل کو `provider/model` کے طور پر سیٹ کریں۔

چیٹ چینل کی دستاویزات (WhatsApp/Telegram/Discord/Slack/Mattermost (پلگ اِن)/وغیرہ) تلاش کر رہے ہیں؟ [Channels](/channels) دیکھیں۔

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

مکمل فراہم کنندہ کیٹلاگ (xAI، Groq، Mistral، وغیرہ) اور جدید کنفیگریشن کے لیے،
[Model providers](/concepts/model-providers) دیکھیں۔
