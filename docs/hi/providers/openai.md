---
summary: "OpenClaw में API कुंजियों या Codex सब्सक्रिप्शन के माध्यम से OpenAI का उपयोग करें"
read_when:
  - आप OpenClaw में OpenAI मॉडल का उपयोग करना चाहते हैं
  - आप API कुंजियों के बजाय Codex सब्सक्रिप्शन प्रमाणीकरण चाहते हैं
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:31Z
---

# OpenAI

OpenAI GPT मॉडलों के लिए डेवलपर APIs प्रदान करता है। Codex सब्सक्रिप्शन
एक्सेस के लिए **ChatGPT साइन-इन** या उपयोग-आधारित एक्सेस के लिए **API कुंजी** साइन-इन का समर्थन करता है। Codex क्लाउड के लिए ChatGPT साइन-इन आवश्यक है।

## विकल्प A: OpenAI API कुंजी (OpenAI प्लेटफ़ॉर्म)

**इसके लिए सर्वोत्तम:** प्रत्यक्ष API एक्सेस और उपयोग-आधारित बिलिंग।
OpenAI डैशबोर्ड से अपनी API कुंजी प्राप्त करें।

### CLI सेटअप

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### विन्यास स्निपेट

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## विकल्प B: OpenAI Code (Codex) सब्सक्रिप्शन

**इसके लिए सर्वोत्तम:** API कुंजी के बजाय ChatGPT/Codex सब्सक्रिप्शन एक्सेस का उपयोग।
Codex क्लाउड के लिए ChatGPT साइन-इन आवश्यक है, जबकि Codex CLI ChatGPT या API कुंजी साइन-इन का समर्थन करता है।

### CLI सेटअप (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### विन्यास स्निपेट (Codex सब्सक्रिप्शन)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## नोट्स

- मॉडल संदर्भ हमेशा `provider/model` का उपयोग करते हैं (देखें [/concepts/models](/concepts/models))।
- प्रमाणीकरण विवरण और पुन: उपयोग नियम [/concepts/oauth](/concepts/oauth) में हैं।
