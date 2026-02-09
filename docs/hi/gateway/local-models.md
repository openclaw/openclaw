---
summary: "स्थानीय LLMs (LM Studio, vLLM, LiteLLM, कस्टम OpenAI एंडपॉइंट्स) पर OpenClaw चलाएँ"
read_when:
  - आप अपने स्वयं के GPU बॉक्स से मॉडल सर्व करना चाहते हैं
  - आप LM Studio या OpenAI-संगत प्रॉक्सी को वायर कर रहे हैं
  - आपको स्थानीय मॉडल के लिए सबसे सुरक्षित मार्गदर्शन चाहिए
title: "स्थानीय मॉडल"
---

# स्थानीय मॉडल

20. Local संभव है, लेकिन OpenClaw बड़े context और prompt injection के विरुद्ध मज़बूत सुरक्षा की अपेक्षा करता है। 21. छोटे कार्ड context को truncate कर देते हैं और सुरक्षा लीक करते हैं। 22. ऊँचा लक्ष्य रखें: **≥2 पूरी तरह maxed-out Mac Studios या समकक्ष GPU रिग (~$30k+)**। 23. एकल **24 GB** GPU केवल हल्के prompts के लिए, अधिक latency के साथ, काम करता है। 24. **सबसे बड़ा / full-size मॉडल वैरिएंट जो आप चला सकते हैं** उपयोग करें; अत्यधिक quantized या “small” checkpoints prompt-injection जोखिम बढ़ाते हैं (देखें [Security](/gateway/security))।

## अनुशंसित: LM Studio + MiniMax M2.1 (Responses API, फुल-साइज़)

25. वर्तमान में सर्वश्रेष्ठ local stack। 26. LM Studio में MiniMax M2.1 लोड करें, local server सक्षम करें (डिफ़ॉल्ट `http://127.0.0.1:1234`), और reasoning को final text से अलग रखने के लिए Responses API का उपयोग करें।

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**सेटअप चेकलिस्ट**

- LM Studio इंस्टॉल करें: [https://lmstudio.ai](https://lmstudio.ai)
- LM Studio में **उपलब्ध सबसे बड़ा MiniMax M2.1 बिल्ड** डाउनलोड करें (“small”/अत्यधिक क्वांटाइज़्ड वैरिएंट्स से बचें), सर्वर शुरू करें, और पुष्टि करें कि `http://127.0.0.1:1234/v1/models` में यह सूचीबद्ध है।
- मॉडल को लोडेड रखें; कोल्ड-लोड से स्टार्टअप विलंबता बढ़ती है।
- यदि आपका LM Studio बिल्ड अलग है तो `contextWindow`/`maxTokens` समायोजित करें।
- WhatsApp के लिए, Responses API पर ही रहें ताकि केवल अंतिम पाठ भेजा जाए।

स्थानीय चलाते समय भी होस्टेड मॉडलों को कॉन्फ़िगर रखें; `models.mode: "merge"` का उपयोग करें ताकि फ़ॉलबैक उपलब्ध रहें।

### हाइब्रिड विन्यास: होस्टेड प्राइमरी, स्थानीय फ़ॉलबैक

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### स्थानीय-प्रथम, होस्टेड सेफ़्टी नेट के साथ

प्राइमरी और फ़ॉलबैक का क्रम बदलें; वही प्रोवाइडर्स ब्लॉक और `models.mode: "merge"` बनाए रखें ताकि स्थानीय बॉक्स डाउन होने पर आप Sonnet या Opus पर फ़ॉलबैक कर सकें।

### क्षेत्रीय होस्टिंग / डेटा रूटिंग

- 27. Hosted MiniMax/Kimi/GLM वैरिएंट OpenRouter पर region-pinned endpoints (जैसे, US-hosted) के साथ भी उपलब्ध हैं। 28. वहाँ regional variant चुनें ताकि ट्रैफ़िक आपके चुने हुए jurisdiction में रहे, जबकि Anthropic/OpenAI fallbacks के लिए `models.mode: "merge"` का उपयोग जारी रहे।
- केवल-स्थानीय सबसे मजबूत गोपनीयता मार्ग है; जब आपको प्रदाता फीचर्स चाहिए लेकिन डेटा प्रवाह पर नियंत्रण चाहते हैं, तब होस्टेड क्षेत्रीय रूटिंग मध्यम मार्ग है।

## अन्य OpenAI-संगत स्थानीय प्रॉक्सी

29. vLLM, LiteLLM, OAI-proxy, या custom gateways काम करते हैं यदि वे OpenAI-स्टाइल `/v1` endpoint expose करते हों। 30. ऊपर दिए गए provider block को अपने endpoint और model ID से बदलें:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

`models.mode: "merge"` बनाए रखें ताकि होस्टेड मॉडल फ़ॉलबैक के रूप में उपलब्ध रहें।

## समस्या-निवारण

- 31. Gateway proxy तक पहुँच पा रहा है? 32. `curl http://127.0.0.1:1234/v1/models`.
- 33. LM Studio मॉडल unloaded? 34. Reload करें; cold start “hanging” का एक सामान्य कारण है।
- 35. Context errors? 36. `contextWindow` कम करें या अपने server limit को बढ़ाएँ।
- सुरक्षा: स्थानीय मॉडल प्रदाता-पक्ष फ़िल्टर्स छोड़ देते हैं; प्रॉम्प्ट-इंजेक्शन के प्रभाव क्षेत्र को सीमित करने के लिए एजेंट्स को संकीर्ण रखें और कंपैक्शन चालू रखें।
