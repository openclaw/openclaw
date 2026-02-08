---
summary: "OpenClaw पर्यावरण चर कहाँ से लोड करता है और प्राथमिकता का क्रम"
read_when:
  - आपको यह जानना हो कि कौन से env vars लोड होते हैं, और किस क्रम में
  - आप Gateway में गायब API कुंजियों का डीबग कर रहे हों
  - आप प्रदाता प्रमाणीकरण या परिनियोजन परिवेशों का दस्तावेज़ीकरण कर रहे हों
title: "पर्यावरण चर"
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:17Z
---

# पर्यावरण चर

OpenClaw कई स्रोतों से पर्यावरण चर लोड करता है। नियम है **मौजूदा मानों को कभी भी ओवरराइड न करें**।

## प्राथमिकता (उच्चतम → न्यूनतम)

1. **प्रोसेस पर्यावरण** (जो Gateway प्रक्रिया को उसके पैरेंट शेल/डेमन से पहले से मिला है)।
2. **वर्तमान कार्यशील निर्देशिका में `.env`** (dotenv डिफ़ॉल्ट; ओवरराइड नहीं करता)।
3. **`~/.openclaw/.env` पर वैश्विक `.env`** (उर्फ़ `$OPENCLAW_STATE_DIR/.env`; ओवरराइड नहीं करता)।
4. **`~/.openclaw/openclaw.json` में Config `env` ब्लॉक** (केवल तब लागू होता है जब मान अनुपस्थित हों)।
5. **वैकल्पिक लॉगिन-शेल इम्पोर्ट** (`env.shellEnv.enabled` या `OPENCLAW_LOAD_SHELL_ENV=1`), केवल अपेक्षित कुंजियों के गायब होने पर लागू।

यदि config फ़ाइल पूरी तरह से अनुपस्थित है, तो चरण 4 छोड़ा जाता है; सक्षम होने पर शेल इम्पोर्ट फिर भी चलता है।

## Config `env` ब्लॉक

इनलाइन env vars सेट करने के दो समकक्ष तरीके (दोनों नॉन-ओवरराइडिंग हैं):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## शेल env इम्पोर्ट

`env.shellEnv` आपका लॉगिन शेल चलाता है और केवल **गायब** अपेक्षित कुंजियों को इम्पोर्ट करता है:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var समतुल्य:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Config में env var प्रतिस्थापन

आप `${VAR_NAME}` सिंटैक्स का उपयोग करके config स्ट्रिंग मानों में सीधे env vars को संदर्भित कर सकते हैं:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

पूर्ण विवरण के लिए [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) देखें।

## संबंधित

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
