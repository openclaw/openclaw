---
summary: "Pangkalahatang-ideya ng model provider na may mga halimbawa ng config + daloy ng CLI"
read_when:
  - Kailangan mo ng sanggunian sa setup ng model ayon sa provider
  - Gusto mo ng mga halimbawa ng config o mga CLI onboarding command para sa mga model provider
title: "Mga Model Provider"
---

# Mga model provider

Sinasaklaw ng pahinang ito ang mga **LLM/model provider** (hindi mga chat channel gaya ng WhatsApp/Telegram).
Para sa mga patakaran sa pagpili ng modelo, tingnan ang [/concepts/models](/concepts/models).

## Mga mabilis na patakaran

- Gumagamit ang mga model ref ng `provider/model` (halimbawa: `opencode/claude-opus-4-6`).
- Kapag itinakda mo ang `agents.defaults.models`, ito ang magiging allowlist.
- Mga helper ng CLI: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Mga built-in na provider (pi-ai catalog)

Kasama sa OpenClaw ang pi‑ai catalog. Ang mga provider na ito ay **hindi nangangailangan ng**
`models.providers` config; mag-set lang ng auth at pumili ng modelo.

### OpenAI

- Provider: `openai`
- Auth: `OPENAI_API_KEY`
- Halimbawang model: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Provider: `anthropic`
- Auth: `ANTHROPIC_API_KEY` o `claude setup-token`
- Halimbawang model: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (i-paste ang setup-token) o `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Provider: `openai-codex`
- Auth: OAuth (ChatGPT)
- Halimbawang model: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` o `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Provider: `opencode`
- Auth: `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`)
- Halimbawang model: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- Provider: `google`
- Auth: `GEMINI_API_KEY`
- Halimbawang model: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, at Gemini CLI

- Mga provider: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Auth: Gumagamit ang Vertex ng gcloud ADC; ginagamit ng Antigravity/Gemini CLI ang kani-kanilang auth flow
- Ang Antigravity OAuth ay kasama bilang bundled plugin (`google-antigravity-auth`, naka-disable bilang default).
  - Paganahin: `openclaw plugins enable google-antigravity-auth`
  - Mag-login: `openclaw models auth login --provider google-antigravity --set-default`
- Ang Gemini CLI OAuth ay kasama bilang bundled plugin (`google-gemini-cli-auth`, naka-disable bilang default).
  - Paganahin: `openclaw plugins enable google-gemini-cli-auth`
  - Mag-login: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Tandaan: **hindi** mo ipi-paste ang client id o secret sa `openclaw.json`. The CLI login flow stores
    tokens in auth profiles on the gateway host.

### Z.AI (GLM)

- Provider: `zai`
- Auth: `ZAI_API_KEY`
- Halimbawang model: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Mga alias: ang `z.ai/*` at `z-ai/*` ay nagno-normalize sa `zai/*`

### Vercel AI Gateway

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- Halimbawang model: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Iba pang built-in na provider

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Halimbawang model: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Ang mga GLM model sa Cerebras ay gumagamit ng mga id na `zai-glm-4.7` at `zai-glm-4.6`.
  - OpenAI-compatible base URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Mga provider sa pamamagitan ng `models.providers` (custom/base URL)

Gamitin ang `models.providers` (o `models.json`) para magdagdag ng **custom** na mga provider o
mga OpenAI/Anthropic‑compatible proxy.

### Moonshot AI (Kimi)

Gumagamit ang Moonshot ng OpenAI-compatible endpoints, kaya i-configure ito bilang custom provider:

- Provider: `moonshot`
- Auth: `MOONSHOT_API_KEY`
- Halimbawang model: `moonshot/kimi-k2.5`

Mga Kimi K2 model ID:

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

Gumagamit ang Kimi Coding ng Anthropic-compatible endpoint ng Moonshot AI:

- Provider: `kimi-coding`
- Auth: `KIMI_API_KEY`
- Halimbawang model: `kimi-coding/k2p5`

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

Mga model ref:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Tingnan ang [/providers/qwen](/providers/qwen) para sa mga detalye ng setup at mga tala.

### Synthetic

Nagbibigay ang Synthetic ng mga Anthropic-compatible na model sa likod ng `synthetic` provider:

- Provider: `synthetic`
- Auth: `SYNTHETIC_API_KEY`
- Halimbawang model: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

Ine-setup ang MiniMax sa pamamagitan ng `models.providers` dahil gumagamit ito ng mga custom endpoint:

- MiniMax (Anthropic‑compatible): `--auth-choice minimax-api`
- Auth: `MINIMAX_API_KEY`

Tingnan ang [/providers/minimax](/providers/minimax) para sa mga detalye ng setup, mga opsyon sa model, at mga snippet ng config.

### Ollama

Ang Ollama ay isang lokal na LLM runtime na nagbibigay ng OpenAI-compatible API:

- Provider: `ollama`
- Auth: Hindi kailangan (lokal na server)
- Halimbawang model: `ollama/llama3.3`
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

### Mga lokal na proxy (LM Studio, vLLM, LiteLLM, atbp.)

Halimbawa (OpenAI‑compatible):

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

Mga tala:

- For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional.
  When omitted, OpenClaw defaults to:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Inirerekomenda: magtakda ng mga tahasang value na tumutugma sa mga limitasyon ng iyong proxy/model.

## Mga halimbawa ng CLI

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Tingnan din: [/gateway/configuration](/gateway/configuration) para sa kumpletong mga halimbawa ng konpigurasyon.
