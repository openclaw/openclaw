---
summary: "မော်ဒယ် ပံ့ပိုးသူ အနှစ်ချုပ်နှင့် ဥပမာ config များ + CLI လုပ်ငန်းစဉ်များ"
read_when:
  - ပံ့ပိုးသူအလိုက် မော်ဒယ် တပ်ဆင်မှု အညွှန်းကို လိုအပ်သည့်အခါ
  - မော်ဒယ် ပံ့ပိုးသူများအတွက် ဥပမာ config များ သို့မဟုတ် CLI onboarding အမိန့်များကို ကြည့်လိုသည့်အခါ
title: "Model Providers"
---

# Model providers

This page covers **LLM/model providers** (not chat channels like WhatsApp/Telegram).
For model selection rules, see [/concepts/models](/concepts/models).

## Quick rules

- မော်ဒယ် refs များသည် `provider/model` ကို အသုံးပြုသည် (ဥပမာ: `opencode/claude-opus-4-6`)။
- `agents.defaults.models` ကို သတ်မှတ်ထားပါက ၎င်းသည် allowlist ဖြစ်လာသည်။
- CLI အကူအညီများ: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`။

## Built-in providers (pi-ai catalog)

OpenClaw ships with the pi‑ai catalog. These providers require **no**
`models.providers` config; just set auth + pick a model.

### OpenAI

- Provider: `openai`
- Auth: `OPENAI_API_KEY`
- Example model: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Provider: `anthropic`
- Auth: `ANTHROPIC_API_KEY` သို့မဟုတ် `claude setup-token`
- Example model: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (setup-token ကို ကူးထည့်ပါ) သို့မဟုတ် `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Provider: `openai-codex`
- Auth: OAuth (ChatGPT)
- Example model: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` သို့မဟုတ် `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Provider: `opencode`
- Auth: `OPENCODE_API_KEY` (သို့မဟုတ် `OPENCODE_ZEN_API_KEY`)
- Example model: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- Provider: `google`
- Auth: `GEMINI_API_KEY`
- Example model: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, and Gemini CLI

- Providers: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Auth: Vertex သည် gcloud ADC ကို အသုံးပြုသည်; Antigravity/Gemini CLI သည် သက်ဆိုင်ရာ auth လုပ်ငန်းစဉ်များကို အသုံးပြုသည်
- Antigravity OAuth ကို bundled plugin အဖြစ် ပို့ဆောင်ထားပြီး (`google-antigravity-auth`, မူလအနေဖြင့် ပိတ်ထားသည်)။
  - Enable: `openclaw plugins enable google-antigravity-auth`
  - Login: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth ကို bundled plugin အဖြစ် ပို့ဆောင်ထားပြီး (`google-gemini-cli-auth`, မူလအနေဖြင့် ပိတ်ထားသည်)။
  - Enable: `openclaw plugins enable google-gemini-cli-auth`
  - Login: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Note: you do **not** paste a client id or secret into `openclaw.json`. The CLI login flow stores
    tokens in auth profiles on the gateway host.

### Z.AI (GLM)

- Provider: `zai`
- Auth: `ZAI_API_KEY`
- Example model: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Aliases: `z.ai/*` နှင့် `z-ai/*` သည် `zai/*` သို့ normalize လုပ်ထားသည်

### Vercel AI Gateway

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- Example model: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Other built-in providers

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Example model: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras ပေါ်ရှိ GLM မော်ဒယ်များသည် `zai-glm-4.7` နှင့် `zai-glm-4.6` ID များကို အသုံးပြုသည်။
  - OpenAI-compatible base URL: `https://api.cerebras.ai/v1`။
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Providers via `models.providers` (custom/base URL)

**custom** ပံ့ပိုးသူများ သို့မဟုတ်
OpenAI/Anthropic‑compatible proxy များကို ထည့်သွင်းရန် `models.providers` (သို့မဟုတ် `models.json`) ကို အသုံးပြုပါ။

### Moonshot AI (Kimi)

Moonshot သည် OpenAI-compatible endpoint များကို အသုံးပြုသဖြင့် custom provider အဖြစ် configure လုပ်ပါ။

- Provider: `moonshot`
- Auth: `MOONSHOT_API_KEY`
- Example model: `moonshot/kimi-k2.5`

Kimi K2 မော်ဒယ် ID များ:

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

Kimi Coding သည် Moonshot AI ၏ Anthropic-compatible endpoint ကို အသုံးပြုသည်။

- Provider: `kimi-coding`
- Auth: `KIMI_API_KEY`
- Example model: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (free tier)

Qwen provides OAuth access to Qwen Coder + Vision via a device-code flow.
Enable the bundled plugin, then log in:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Model refs:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

တပ်ဆင်မှု အသေးစိတ်များနှင့် မှတ်ချက်များအတွက် [/providers/qwen](/providers/qwen) ကို ကြည့်ပါ။

### Synthetic

Synthetic သည် `synthetic` provider နောက်ကွယ်တွင် Anthropic-compatible မော်ဒယ်များကို ပံ့ပိုးပါသည်။

- Provider: `synthetic`
- Auth: `SYNTHETIC_API_KEY`
- Example model: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax သည် custom endpoint များကို အသုံးပြုသဖြင့် `models.providers` ဖြင့် configure လုပ်ပါသည်။

- MiniMax (Anthropic‑compatible): `--auth-choice minimax-api`
- Auth: `MINIMAX_API_KEY`

တပ်ဆင်မှု အသေးစိတ်များ၊ မော်ဒယ် ရွေးချယ်စရာများနှင့် config snippet များအတွက် [/providers/minimax](/providers/minimax) ကို ကြည့်ပါ။

### Ollama

Ollama သည် OpenAI-compatible API ကို ပံ့ပိုးသည့် local LLM runtime တစ်ခု ဖြစ်ပါသည်။

- Provider: `ollama`
- Auth: မလိုအပ်ပါ (local server)
- Example model: `ollama/llama3.3`
- Installation: [https://ollama.ai](https://ollama.ai)

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

### Local proxies (LM Studio, vLLM, LiteLLM, etc.)

ဥပမာ (OpenAI‑compatible):

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

Notes:

- For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional.
  When omitted, OpenClaw defaults to:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- အကြံပြုချက်: သင့် proxy/မော်ဒယ် ကန့်သတ်ချက်များနှင့် ကိုက်ညီသည့် တိတိကျကျ တန်ဖိုးများကို သတ်မှတ်ပါ။

## CLI examples

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

နောက်ထပ်ကြည့်ရန်: ပြည့်စုံသော configuration ဥပမာများအတွက် [/gateway/configuration](/gateway/configuration) ကို ကြည့်ပါ။
