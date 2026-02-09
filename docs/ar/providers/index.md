---
summary: "موفّرو النماذج (LLMs) المدعومون من OpenClaw"
read_when:
  - تريد اختيار موفّر نموذج
  - تحتاج إلى نظرة عامة سريعة على واجهات LLM الخلفية المدعومة
title: "موفّرو النماذج"
---

# موفّرو النماذج

يمكن لـ OpenClaw استخدام العديد من موفّري LLM. اختر موفّرًا، ثم قم بالمصادقة، وبعدها اضبط
النموذج الافتراضي على `provider/model`.

هل تبحث عن توثيق قنوات الدردشة (WhatsApp/Telegram/Discord/Slack/Mattermost (إضافة)/إلخ)؟ راجع [القنوات](/channels). انظر [Channels](/channels).

## تسليط الضوء: Venice (Venice AI)

تُعد Venice إعداد Venice AI الموصى به لدينا للاستدلال الذي يركّز على الخصوصية، مع خيار استخدام Opus للمهام الصعبة.

- الافتراضي: `venice/llama-3.3-70b`
- الأفضل إجمالًا: `venice/claude-opus-45` (لا يزال Opus الأقوى)

انظر [Venice AI](/providers/venice).

## البدء السريع

1. قم بالمصادقة مع الموفّر (عادةً عبر `openclaw onboard`).
2. اضبط النموذج الافتراضي:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## توثيق الموفّرين

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
- [Venice (Venice AI، يركّز على الخصوصية)](/providers/venice)
- [Ollama (نماذج محلية)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## موفري خدمات الترجمة

- [Deepgram (نسخ الصوت)](/providers/deepgram)

## أدوات المجتمع

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - استخدم اشتراك Claude Max/Pro كنقطة نهاية API متوافقة مع OpenAI

للاطلاع على كتالوج الموفّرين الكامل (xAI، Groq، Mistral، إلخ) والتهيئة المتقدمة،
راجع [موفّري النماذج](/concepts/model-providers). للاطلاع على كتالوج الموفّرين الكامل (xAI وGroq وMistral وغيرها) والإعدادات المتقدمة،
انظر [موفّرو النماذج](/concepts/model-providers).
