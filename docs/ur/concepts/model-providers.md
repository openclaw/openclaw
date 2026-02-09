---
summary: "ماڈل فراہم کنندگان کا جائزہ، مثال کنفیگز اور CLI فلو"
read_when:
  - آپ کو فراہم کنندہ بہ فراہم کنندہ ماڈل سیٹ اپ کا حوالہ درکار ہو
  - آپ ماڈل فراہم کنندگان کے لیے مثال کنفیگز یا CLI آن بورڈنگ کمانڈز چاہتے ہوں
title: "ماڈل فراہم کنندگان"
---

# ماڈل فراہم کنندگان

This page covers **LLM/model providers** (not chat channels like WhatsApp/Telegram).
For model selection rules, see [/concepts/models](/concepts/models).

## فوری قواعد

- ماڈل ریفرنسز `provider/model` استعمال کرتے ہیں (مثال: `opencode/claude-opus-4-6`)۔
- اگر آپ `agents.defaults.models` سیٹ کریں، تو وہ اجازت فہرست بن جاتا ہے۔
- CLI معاونین: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`۔

## بلٹ اِن فراہم کنندگان (pi-ai کیٹلاگ)

OpenClaw ships with the pi‑ai catalog. These providers require **no**
`models.providers` config; just set auth + pick a model.

### OpenAI

- فراہم کنندہ: `openai`
- تصدیق: `OPENAI_API_KEY`
- مثال ماڈل: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- فراہم کنندہ: `anthropic`
- تصدیق: `ANTHROPIC_API_KEY` یا `claude setup-token`
- مثال ماڈل: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (setup-token پیسٹ کریں) یا `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- فراہم کنندہ: `openai-codex`
- تصدیق: OAuth (ChatGPT)
- مثال ماڈل: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` یا `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- فراہم کنندہ: `opencode`
- تصدیق: `OPENCODE_API_KEY` (یا `OPENCODE_ZEN_API_KEY`)
- مثال ماڈل: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API کلید)

- فراہم کنندہ: `google`
- تصدیق: `GEMINI_API_KEY`
- مثال ماڈل: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex، Antigravity، اور Gemini CLI

- فراہم کنندگان: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- تصدیق: Vertex گکلاؤڈ ADC استعمال کرتا ہے؛ Antigravity/Gemini CLI اپنے متعلقہ تصدیقی فلو استعمال کرتے ہیں
- Antigravity OAuth بطور بنڈلڈ پلگ اِن فراہم کیا جاتا ہے (`google-antigravity-auth`، بطورِ طے شدہ غیرفعال)۔
  - فعال کریں: `openclaw plugins enable google-antigravity-auth`
  - لاگ اِن: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth بطور بنڈلڈ پلگ اِن فراہم کیا جاتا ہے (`google-gemini-cli-auth`، بطورِ طے شدہ غیرفعال)۔
  - فعال کریں: `openclaw plugins enable google-gemini-cli-auth`
  - لاگ اِن: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Note: you do **not** paste a client id or secret into `openclaw.json`. The CLI login flow stores
    tokens in auth profiles on the gateway host.

### Z.AI (GLM)

- فراہم کنندہ: `zai`
- تصدیق: `ZAI_API_KEY`
- مثال ماڈل: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - عرفیات: `z.ai/*` اور `z-ai/*`، `zai/*` پر نارملائز ہوتے ہیں

### Vercel AI Gateway

- فراہم کنندہ: `vercel-ai-gateway`
- تصدیق: `AI_GATEWAY_API_KEY`
- مثال ماڈل: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### دیگر بلٹ اِن فراہم کنندگان

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- مثال ماڈل: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras پر GLM ماڈلز آئی ڈیز `zai-glm-4.7` اور `zai-glm-4.6` استعمال کرتے ہیں۔
  - OpenAI‑مطابقت رکھنے والا بیس URL: `https://api.cerebras.ai/v1`۔
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## `models.providers` کے ذریعے فراہم کنندگان (custom/base URL)

**حسبِ ضرورت** فراہم کنندگان یا
OpenAI/Anthropic‑مطابقت رکھنے والے پراکسیز شامل کرنے کے لیے `models.providers` (یا `models.json`) استعمال کریں۔

### Moonshot AI (Kimi)

Moonshot OpenAI‑مطابقت رکھنے والے اینڈ پوائنٹس استعمال کرتا ہے، اس لیے اسے بطور حسبِ ضرورت فراہم کنندہ کنفیگر کریں:

- فراہم کنندہ: `moonshot`
- تصدیق: `MOONSHOT_API_KEY`
- مثال ماڈل: `moonshot/kimi-k2.5`

Kimi K2 ماڈل آئی ڈیز:

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

Kimi Coding، Moonshot AI کے Anthropic‑مطابقت رکھنے والے اینڈ پوائنٹ استعمال کرتا ہے:

- فراہم کنندہ: `kimi-coding`
- تصدیق: `KIMI_API_KEY`
- مثال ماڈل: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (فری ٹائر)

Qwen provides OAuth access to Qwen Coder + Vision via a device-code flow.
Enable the bundled plugin, then log in:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

ماڈل ریفرنسز:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

سیٹ اپ کی تفصیلات اور نوٹس کے لیے دیکھیں [/providers/qwen](/providers/qwen)۔

### Synthetic

Synthetic، `synthetic` فراہم کنندہ کے پیچھے Anthropic‑مطابقت رکھنے والے ماڈلز فراہم کرتا ہے:

- فراہم کنندہ: `synthetic`
- تصدیق: `SYNTHETIC_API_KEY`
- مثال ماڈل: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax، حسبِ ضرورت اینڈ پوائنٹس استعمال کرنے کے باعث `models.providers` کے ذریعے کنفیگر ہوتا ہے:

- MiniMax (Anthropic‑مطابقت رکھنے والا): `--auth-choice minimax-api`
- تصدیق: `MINIMAX_API_KEY`

سیٹ اپ کی تفصیلات، ماڈل اختیارات، اور کنفیگ ٹکڑوں کے لیے دیکھیں [/providers/minimax](/providers/minimax)۔

### Ollama

Ollama ایک مقامی LLM رن ٹائم ہے جو OpenAI‑مطابقت رکھنے والا API فراہم کرتا ہے:

- فراہم کنندہ: `ollama`
- تصدیق: درکار نہیں (مقامی سرور)
- مثال ماڈل: `ollama/llama3.3`
- انسٹالیشن: [https://ollama.ai](https://ollama.ai)

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

Ollama is automatically detected when running locally at `http://127.0.0.1:11434/v1`. See [/providers/ollama](/providers/ollama) for model recommendations and custom configuration.

### مقامی پراکسیز (LM Studio، vLLM، LiteLLM، وغیرہ)

مثال (OpenAI‑مطابقت رکھنے والا):

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

نوٹس:

- For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional.
  When omitted, OpenClaw defaults to:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- سفارش کردہ: اپنے پراکسی/ماڈل کی حدود کے مطابق واضح قدریں سیٹ کریں۔

## CLI مثالیں

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

مزید دیکھیں: مکمل کنفیگریشن مثالوں کے لیے [/gateway/configuration](/gateway/configuration)۔
