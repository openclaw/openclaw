---
summary: "OpenClaw में Synthetic के Anthropic-संगत API का उपयोग करें"
read_when:
  - आप Synthetic को मॉडल प्रदाता के रूप में उपयोग करना चाहते हैं
  - आपको Synthetic API कुंजी या बेस URL सेटअप की आवश्यकता है
title: "Synthetic"
x-i18n:
  source_path: providers/synthetic.md
  source_hash: f3f6e3eb86466175
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:39Z
---

# Synthetic

Synthetic Anthropic-संगत एंडपॉइंट्स प्रदान करता है। OpenClaw इसे
`synthetic` प्रदाता के रूप में पंजीकृत करता है और Anthropic Messages API का उपयोग करता है।

## त्वरित सेटअप

1. `SYNTHETIC_API_KEY` सेट करें (या नीचे दिए गए विज़ार्ड को चलाएँ)।
2. ऑनबोर्डिंग चलाएँ:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

डिफ़ॉल्ट मॉडल इस पर सेट है:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## विन्यास उदाहरण

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

टिप्पणी: OpenClaw का Anthropic क्लाइंट बेस URL में `/v1` जोड़ता है, इसलिए
`https://api.synthetic.new/anthropic` का उपयोग करें (`/anthropic/v1` नहीं)। यदि Synthetic अपना
बेस URL बदलता है, तो `models.providers.synthetic.baseUrl` ओवरराइड करें।

## मॉडल कैटलॉग

नीचे दिए गए सभी मॉडल लागत `0` (इनपुट/आउटपुट/कैश) का उपयोग करते हैं।

| मॉडल ID                                                | संदर्भ विंडो | अधिकतम टोकन | तर्क  | इनपुट        |
| ------------------------------------------------------ | ------------ | ----------- | ----- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000       | 65536       | false | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000       | 8192        | true  | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000       | 128000      | false | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000       | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000       | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000       | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000       | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000       | 8192        | false | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000       | 8192        | false | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000       | 8192        | false | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000       | 8192        | false | text         |
| `hf:openai/gpt-oss-120b`                               | 128000       | 8192        | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000       | 8192        | false | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000       | 8192        | false | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000       | 8192        | false | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000       | 128000      | false | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000       | 128000      | false | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000       | 8192        | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000       | 8192        | true  | text         |

## टिप्पणियाँ

- मॉडल संदर्भ `synthetic/<modelId>` का उपयोग करते हैं।
- यदि आप मॉडल allowlist (`agents.defaults.models`) सक्षम करते हैं, तो जिन सभी मॉडलों का
  आप उपयोग करने की योजना बनाते हैं, उन्हें जोड़ें।
- प्रदाता नियमों के लिए [Model providers](/concepts/model-providers) देखें।
