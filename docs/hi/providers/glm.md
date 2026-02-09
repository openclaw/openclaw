---
summary: "GLM मॉडल परिवार का अवलोकन + OpenClaw में इसका उपयोग कैसे करें"
read_when:
  - आप OpenClaw में GLM मॉडल चाहते हैं
  - आपको मॉडल नामकरण परंपरा और सेटअप की आवश्यकता है
title: "GLM मॉडल"
---

# GLM मॉडल

GLM is a **model family** (not a company) available through the Z.AI platform. In OpenClaw, GLM
models are accessed via the `zai` provider and model IDs like `zai/glm-4.7`.

## CLI सेटअप

```bash
openclaw onboard --auth-choice zai-api-key
```

## Config स्निपेट

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## नोट्स

- GLM के संस्करण और उपलब्धता बदल सकते हैं; नवीनतम जानकारी के लिए Z.AI के दस्तावेज़ देखें।
- उदाहरण मॉडल IDs में `glm-4.7` और `glm-4.6` शामिल हैं।
- प्रदाता विवरण के लिए, देखें [/providers/zai](/providers/zai)।
