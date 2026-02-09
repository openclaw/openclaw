---
summary: "उदाहरण विन्यास + CLI प्रवाहों सहित मॉडल प्रदाता अवलोकन"
read_when:
  - आपको प्रदाता‑दर‑प्रदाता मॉडल सेटअप संदर्भ की आवश्यकता हो
  - आप मॉडल प्रदाताओं के लिए उदाहरण विन्यास या CLI ऑनबोर्डिंग कमांड चाहते हों
title: "मॉडल प्रदाता"
---

# मॉडल प्रदाता

8. यह पेज **LLM/मॉडल प्रोवाइडर्स** को कवर करता है (WhatsApp/Telegram जैसे चैट चैनल नहीं)।
   For model selection rules, see [/concepts/models](/concepts/models).

## त्वरित नियम

- मॉडल संदर्भ `provider/model` का उपयोग करते हैं (उदाहरण: `opencode/claude-opus-4-6`)।
- यदि आप `agents.defaults.models` सेट करते हैं, तो वही allowlist बन जाता है।
- CLI सहायक: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`।

## अंतर्निर्मित प्रदाता (pi‑ai कैटलॉग)

10. OpenClaw pi‑ai कैटलॉग के साथ आता है। 11. इन प्रोवाइडर्स के लिए **कोई** `models.providers` कॉन्फ़िग आवश्यक नहीं है; बस auth सेट करें + एक मॉडल चुनें।

### OpenAI

- प्रदाता: `openai`
- प्रमाणीकरण: `OPENAI_API_KEY`
- उदाहरण मॉडल: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- प्रदाता: `anthropic`
- प्रमाणीकरण: `ANTHROPIC_API_KEY` या `claude setup-token`
- उदाहरण मॉडल: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (setup-token पेस्ट करें) या `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- प्रदाता: `openai-codex`
- प्रमाणीकरण: OAuth (ChatGPT)
- उदाहरण मॉडल: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` या `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- प्रदाता: `opencode`
- प्रमाणीकरण: `OPENCODE_API_KEY` (या `OPENCODE_ZEN_API_KEY`)
- उदाहरण मॉडल: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- प्रदाता: `google`
- प्रमाणीकरण: `GEMINI_API_KEY`
- उदाहरण मॉडल: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, और Gemini CLI

- प्रदाता: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- प्रमाणीकरण: Vertex gcloud ADC का उपयोग करता है; Antigravity/Gemini CLI अपने‑अपने प्रमाणीकरण प्रवाहों का उपयोग करते हैं
- Antigravity OAuth एक बंडल्ड प्लगइन के रूप में प्रदान किया जाता है (`google-antigravity-auth`, डिफ़ॉल्ट रूप से अक्षम)।
  - सक्षम करें: `openclaw plugins enable google-antigravity-auth`
  - लॉगिन: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth एक बंडल्ड प्लगइन के रूप में प्रदान किया जाता है (`google-gemini-cli-auth`, डिफ़ॉल्ट रूप से अक्षम)।
  - सक्षम करें: `openclaw plugins enable google-gemini-cli-auth`
  - लॉगिन: `openclaw models auth login --provider google-gemini-cli --set-default`
  - 12. नोट: आप `openclaw.json` में क्लाइंट id या सीक्रेट **पेस्ट नहीं** करते। 13. CLI लॉगिन फ़्लो गेटवे होस्ट पर auth प्रोफ़ाइल्स में टोकन संग्रहीत करता है।

### Z.AI (GLM)

- प्रदाता: `zai`
- प्रमाणीकरण: `ZAI_API_KEY`
- उदाहरण मॉडल: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - उपनाम: `z.ai/*` और `z-ai/*` को `zai/*` में सामान्यीकृत किया जाता है

### Vercel AI Gateway

- प्रदाता: `vercel-ai-gateway`
- प्रमाणीकरण: `AI_GATEWAY_API_KEY`
- उदाहरण मॉडल: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### अन्य अंतर्निर्मित प्रदाता

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- उदाहरण मॉडल: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras पर GLM मॉडल आईडी `zai-glm-4.7` और `zai-glm-4.6` का उपयोग करते हैं।
  - OpenAI‑संगत बेस URL: `https://api.cerebras.ai/v1`।
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## `models.providers` के माध्यम से प्रदाता (custom/base URL)

**कस्टम** प्रदाता या
OpenAI/Anthropic‑संगत प्रॉक्सी जोड़ने के लिए `models.providers` (या `models.json`) का उपयोग करें।

### Moonshot AI (Kimi)

Moonshot OpenAI‑संगत एंडपॉइंट्स का उपयोग करता है, इसलिए इसे कस्टम प्रदाता के रूप में विन्यस्त करें:

- प्रदाता: `moonshot`
- प्रमाणीकरण: `MOONSHOT_API_KEY`
- उदाहरण मॉडल: `moonshot/kimi-k2.5`

Kimi K2 मॉडल आईडी:

{/_moonshot-kimi-k2-model-refs:start_/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-model-refs:end_/ && null}

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding Moonshot AI के Anthropic‑संगत एंडपॉइंट का उपयोग करता है:

- प्रदाता: `kimi-coding`
- प्रमाणीकरण: `KIMI_API_KEY`
- उदाहरण मॉडल: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (मुफ़्त स्तर)

14. Qwen डिवाइस‑कोड फ़्लो के माध्यम से Qwen Coder + Vision के लिए OAuth एक्सेस प्रदान करता है।
15. बंडल्ड प्लगइन सक्षम करें, फिर लॉग इन करें:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

मॉडल संदर्भ:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

सेटअप विवरण और टिप्पणियों के लिए देखें [/providers/qwen](/providers/qwen)।

### Synthetic

Synthetic, `synthetic` प्रदाता के पीछे Anthropic‑संगत मॉडल प्रदान करता है:

- प्रदाता: `synthetic`
- प्रमाणीकरण: `SYNTHETIC_API_KEY`
- उदाहरण मॉडल: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],
      },
    },
  },
}
```

### MiniMax

MiniMax को `models.providers` के माध्यम से विन्यस्त किया जाता है क्योंकि यह कस्टम एंडपॉइंट्स का उपयोग करता है:

- MiniMax (Anthropic‑संगत): `--auth-choice minimax-api`
- प्रमाणीकरण: `MINIMAX_API_KEY`

सेटअप विवरण, मॉडल विकल्प, और विन्यास स्निपेट्स के लिए देखें [/providers/minimax](/providers/minimax)।

### Ollama

Ollama एक स्थानीय LLM रनटाइम है जो OpenAI‑संगत API प्रदान करता है:

- प्रदाता: `ollama`
- प्रमाणीकरण: आवश्यक नहीं (स्थानीय सर्वर)
- उदाहरण मॉडल: `ollama/llama3.3`
- स्थापना: [https://ollama.ai](https://ollama.ai)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama is automatically detected when running locally at `http://127.0.0.1:11434/v1`. 17. मॉडल अनुशंसाओं और कस्टम कॉन्फ़िगरेशन के लिए [/providers/ollama](/providers/ollama) देखें।

### स्थानीय प्रॉक्सी (LM Studio, vLLM, LiteLLM, आदि)

उदाहरण (OpenAI‑संगत):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

टिप्पणियाँ:

- 18. कस्टम प्रोवाइडर्स के लिए, `reasoning`, `input`, `cost`, `contextWindow`, और `maxTokens` वैकल्पिक हैं।
  19. जब छोड़े जाते हैं, तो OpenClaw डिफ़ॉल्ट रूप से सेट करता है:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- अनुशंसित: ऐसे स्पष्ट मान सेट करें जो आपके प्रॉक्सी/मॉडल सीमाओं से मेल खाते हों।

## CLI उदाहरण

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

पूर्ण विन्यास उदाहरणों के लिए यह भी देखें: [/gateway/configuration](/gateway/configuration)।
