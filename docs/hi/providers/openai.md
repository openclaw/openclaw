---
summary: "OpenClaw में API कुंजियों या Codex सब्सक्रिप्शन के माध्यम से OpenAI का उपयोग करें"
read_when:
  - आप OpenClaw में OpenAI मॉडल का उपयोग करना चाहते हैं
  - आप API कुंजियों के बजाय Codex सब्सक्रिप्शन प्रमाणीकरण चाहते हैं
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Codex supports **ChatGPT sign-in** for subscription
access or **API key** sign-in for usage-based access. Codex cloud requires ChatGPT sign-in.

## विकल्प A: OpenAI API कुंजी (OpenAI प्लेटफ़ॉर्म)

**Best for:** direct API access and usage-based billing.
Get your API key from the OpenAI dashboard.

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

**Best for:** using ChatGPT/Codex subscription access instead of an API key.
Codex cloud requires ChatGPT sign-in, while the Codex CLI supports ChatGPT or API key sign-in.

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
