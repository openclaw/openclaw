---
summary: "OpenClaw के साथ Z.AI (GLM मॉडल) का उपयोग करें"
read_when:
  - आप OpenClaw में Z.AI / GLM मॉडल चाहते हैं
  - आपको एक सरल ZAI_API_KEY सेटअप की आवश्यकता है
title: "Z.AI"
x-i18n:
  source_path: providers/zai.md
  source_hash: 2c24bbad86cf86c3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:33Z
---

# Z.AI

Z.AI **GLM** मॉडलों के लिए API प्लेटफ़ॉर्म है। यह GLM के लिए REST APIs प्रदान करता है और प्रमाणीकरण
के लिए API कुंजियों का उपयोग करता है। Z.AI कंसोल में अपनी API कुंजी बनाएँ। OpenClaw एक Z.AI API कुंजी
के साथ `zai` प्रदाता का उपयोग करता है।

## CLI सेटअप

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## विन्यास स्निपेट

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## टिप्पणियाँ

- GLM मॉडल `zai/<model>` के रूप में उपलब्ध हैं (उदाहरण: `zai/glm-4.7`)।
- मॉडल परिवार के अवलोकन के लिए [/providers/glm](/providers/glm) देखें।
- Z.AI आपकी API कुंजी के साथ Bearer auth का उपयोग करता है।
