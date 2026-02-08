---
summary: "موفّرو النماذج (LLMs) المدعومون بواسطة OpenClaw"
read_when:
  - تريد اختيار موفّر نموذج
  - تريد أمثلة إعداد سريعة لمصادقة LLM + اختيار النموذج
title: "البدء السريع لموفّر النموذج"
x-i18n:
  source_path: providers/models.md
  source_hash: 691d2c97ef6b01cc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:31Z
---

# موفّرو النماذج

يمكن لـ OpenClaw استخدام العديد من موفّري LLM. اختر واحدًا، قم بالمصادقة، ثم اضبط
النموذج الافتراضي على `provider/model`.

## تمييز: Venice (Venice AI)

Venice هو إعدادنا الموصى به من Venice AI للاستدلال الذي يركّز على الخصوصية، مع خيار استخدام Opus لأصعب المهام.

- الافتراضي: `venice/llama-3.3-70b`
- الأفضل إجمالًا: `venice/claude-opus-45` (لا يزال Opus الأقوى)

انظر [Venice AI](/providers/venice).

## البدء السريع (خطوتان)

1. قم بالمصادقة مع الموفّر (عادةً عبر `openclaw onboard`).
2. اضبط النموذج الافتراضي:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## الموفّرون المدعومون (المجموعة الأساسية)

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

للاطلاع على كتالوج الموفّرين الكامل (xAI وGroq وMistral وغيرها) والإعدادات المتقدمة،
انظر [موفّرو النماذج](/concepts/model-providers).
