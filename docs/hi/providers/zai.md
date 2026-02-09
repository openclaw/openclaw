---
summary: "OpenClaw के साथ Z.AI (GLM मॉडल) का उपयोग करें"
read_when:
  - आप OpenClaw में Z.AI / GLM मॉडल चाहते हैं
  - आपको एक सरल ZAI_API_KEY सेटअप की आवश्यकता है
title: "Z.AI"
---

# Z.AI

Z.AI is the API platform for **GLM** models. It provides REST APIs for GLM and uses API keys
for authentication. Create your API key in the Z.AI console. OpenClaw uses the `zai` provider
with a Z.AI API key.

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
