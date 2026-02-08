---
summary: "GLM मॉडल परिवार का अवलोकन + OpenClaw में इसका उपयोग कैसे करें"
read_when:
  - आप OpenClaw में GLM मॉडल चाहते हैं
  - आपको मॉडल नामकरण परंपरा और सेटअप की आवश्यकता है
title: "GLM मॉडल"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:31Z
---

# GLM मॉडल

GLM एक **मॉडल परिवार** है (कोई कंपनी नहीं) जो Z.AI प्लेटफ़ॉर्म के माध्यम से उपलब्ध है। OpenClaw में, GLM
मॉडल `zai` प्रदाता और `zai/glm-4.7` जैसे मॉडल IDs के माध्यम से एक्सेस किए जाते हैं।

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
