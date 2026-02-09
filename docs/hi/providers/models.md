---
summary: "OpenClaw द्वारा समर्थित मॉडल प्रदाता (LLMs)"
read_when:
  - आप किसी मॉडल प्रदाता का चयन करना चाहते हैं
  - आप LLM प्रमाणीकरण + मॉडल चयन के लिए त्वरित सेटअप उदाहरण चाहते हैं
title: "मॉडल प्रदाता त्वरित प्रारंभ"
---

# मॉडल प्रदाता

OpenClaw can use many LLM providers. Pick one, authenticate, then set the default
model as `provider/model`.

## हाइलाइट: Venice (Venice AI)

Venice हमारी अनुशंसित Venice AI सेटअप है, जो गोपनीयता-प्रथम इनफ़ेरेंस के लिए है और सबसे कठिन कार्यों के लिए Opus का उपयोग करने का विकल्प देती है।

- डिफ़ॉल्ट: `venice/llama-3.3-70b`
- सर्वोत्तम समग्र: `venice/claude-opus-45` (Opus सबसे शक्तिशाली बना रहता है)

देखें [Venice AI](/providers/venice)।

## त्वरित प्रारंभ (दो चरण)

1. प्रदाता के साथ प्रमाणीकरण करें (आमतौर पर `openclaw onboard` के माध्यम से)।
2. डिफ़ॉल्ट मॉडल सेट करें:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## समर्थित प्रदाता (स्टार्टर सेट)

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

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
