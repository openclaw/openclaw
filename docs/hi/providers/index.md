---
summary: "OpenClaw द्वारा समर्थित मॉडल प्रदाता (LLMs)"
read_when:
  - आप किसी मॉडल प्रदाता का चयन करना चाहते हैं
  - आपको समर्थित LLM बैकएंड का त्वरित अवलोकन चाहिए
title: "मॉडल प्रदाता"
---

# मॉडल प्रदाता

OpenClaw can use many LLM providers. Pick a provider, authenticate, then set the
default model as `provider/model`.

Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? See [Channels](/channels).

## हाइलाइट: Venice (Venice AI)

Venice, गोपनीयता-प्रथम इंफेरेंस के लिए हमारा अनुशंसित Venice AI सेटअप है, जिसमें कठिन कार्यों के लिए Opus उपयोग करने का विकल्प है।

- डिफ़ॉल्ट: `venice/llama-3.3-70b`
- सर्वश्रेष्ठ समग्र: `venice/claude-opus-45` (Opus सबसे शक्तिशाली बना रहता है)

देखें [Venice AI](/providers/venice)।

## त्वरित प्रारंभ

1. प्रदाता के साथ प्रमाणीकरण करें (आमतौर पर `openclaw onboard` के माध्यम से)।
2. डिफ़ॉल्ट मॉडल सेट करें:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## प्रदाता दस्तावेज़

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
- [Venice (Venice AI, गोपनीयता-केंद्रित)](/providers/venice)
- [Ollama (स्थानीय मॉडल)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## ट्रांसक्रिप्शन प्रदाता

- [Deepgram (ऑडियो ट्रांसक्रिप्शन)](/providers/deepgram)

## समुदाय टूल्स

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro सब्सक्रिप्शन को OpenAI-संगत API एंडपॉइंट के रूप में उपयोग करें

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
