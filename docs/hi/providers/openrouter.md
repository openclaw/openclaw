---
summary: "OpenClaw में कई मॉडलों तक पहुँच के लिए OpenRouter के एकीकृत API का उपयोग करें"
read_when:
  - आप कई LLMs के लिए एक ही API कुंजी चाहते हैं
  - आप OpenClaw में OpenRouter के माध्यम से मॉडल चलाना चाहते हैं
title: "OpenRouter"
x-i18n:
  source_path: providers/openrouter.md
  source_hash: b7e29fc9c456c64d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:36Z
---

# OpenRouter

OpenRouter एक **एकीकृत API** प्रदान करता है जो एक ही एंडपॉइंट और API कुंजी के पीछे कई मॉडलों तक अनुरोधों को रूट करता है। यह OpenAI-संगत है, इसलिए बेस URL बदलकर अधिकांश OpenAI SDKs काम करते हैं।

## CLI सेटअप

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## विन्यास स्निपेट

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## टिप्पणियाँ

- मॉडल संदर्भ `openrouter/<provider>/<model>` हैं।
- अधिक मॉडल/प्रदाता विकल्पों के लिए, देखें [/concepts/model-providers](/concepts/model-providers)।
- OpenRouter आंतरिक रूप से आपकी API कुंजी के साथ एक बेयरर टोकन का उपयोग करता है।
