---
summary: "OpenClaw کے ذریعے معاونت یافتہ ماڈل فراہم کنندگان (LLMs)"
read_when:
  - آپ ماڈل فراہم کنندہ منتخب کرنا چاہتے ہوں
  - آپ LLM تصدیق اور ماڈل انتخاب کے لیے فوری سیٹ اپ مثالیں چاہتے ہوں
title: "ماڈل فراہم کنندہ فوری آغاز"
x-i18n:
  source_path: providers/models.md
  source_hash: 691d2c97ef6b01cc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:31Z
---

# ماڈل فراہم کنندگان

OpenClaw متعدد LLM فراہم کنندگان استعمال کر سکتا ہے۔ ایک منتخب کریں، تصدیق کریں، پھر ڈیفالٹ
ماڈل کو `provider/model` کے طور پر سیٹ کریں۔

## نمایاں: Venice (Venice AI)

Venice ہماری تجویز کردہ Venice AI سیٹ اپ ہے، جو رازداری کو ترجیح دینے والی انفیرنس فراہم کرتا ہے اور مشکل ترین کاموں کے لیے Opus استعمال کرنے کا اختیار دیتا ہے۔

- ڈیفالٹ: `venice/llama-3.3-70b`
- مجموعی طور پر بہترین: `venice/claude-opus-45` (Opus اب بھی سب سے مضبوط ہے)

دیکھیں [Venice AI](/providers/venice)۔

## فوری آغاز (دو مراحل)

1. فراہم کنندہ کے ساتھ تصدیق کریں (عموماً `openclaw onboard` کے ذریعے)۔
2. ڈیفالٹ ماڈل سیٹ کریں:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## معاونت یافتہ فراہم کنندگان (ابتدائی سیٹ)

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

مکمل فراہم کنندہ کیٹلاگ (xAI، Groq، Mistral، وغیرہ) اور اعلیٰ درجے کی کنفیگریشن کے لیے،
دیکھیں [Model providers](/concepts/model-providers)۔
