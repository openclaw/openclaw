---
summary: "Översikt över modellleverantörer med exempel på konfigurationer + CLI-flöden"
read_when:
  - Du behöver en referens för modellkonfiguration per leverantör
  - Du vill ha exempel på konfigurationer eller CLI-kommandon för introduktion till modellleverantörer
title: "Modellleverantörer"
x-i18n:
  source_path: concepts/model-providers.md
  source_hash: b086e62236225de6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:04Z
---

# Modellleverantörer

Den här sidan täcker **LLM-/modellleverantörer** (inte chattkanaler som WhatsApp/Telegram).
För regler för modellval, se [/concepts/models](/concepts/models).

## Snabba regler

- Modellreferenser använder `provider/model` (exempel: `opencode/claude-opus-4-6`).
- Om du anger `agents.defaults.models` blir den tillåtelselistan.
- CLI-hjälpare: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Inbyggda leverantörer (pi-ai-katalogen)

OpenClaw levereras med pi‑ai-katalogen. Dessa leverantörer kräver **ingen**
`models.providers`-konfig; ange bara autentisering + välj en modell.

### OpenAI

- Leverantör: `openai`
- Autentisering: `OPENAI_API_KEY`
- Exempelmodell: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Leverantör: `anthropic`
- Autentisering: `ANTHROPIC_API_KEY` eller `claude setup-token`
- Exempelmodell: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (klistra in setup-token) eller `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Leverantör: `openai-codex`
- Autentisering: OAuth (ChatGPT)
- Exempelmodell: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` eller `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Leverantör: `opencode`
- Autentisering: `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`)
- Exempelmodell: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API-nyckel)

- Leverantör: `google`
- Autentisering: `GEMINI_API_KEY`
- Exempelmodell: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity och Gemini CLI

- Leverantörer: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Autentisering: Vertex använder gcloud ADC; Antigravity/Gemini CLI använder sina respektive autentiseringsflöden
- Antigravity OAuth levereras som ett medföljande plugin (`google-antigravity-auth`, inaktiverat som standard).
  - Aktivera: `openclaw plugins enable google-antigravity-auth`
  - Logga in: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth levereras som ett medföljande plugin (`google-gemini-cli-auth`, inaktiverat som standard).
  - Aktivera: `openclaw plugins enable google-gemini-cli-auth`
  - Logga in: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Obs: du klistrar **inte** in ett klient-ID eller hemlighet i `openclaw.json`. CLI-inloggningsflödet lagrar
    tokens i autentiseringsprofiler på gateway-värden.

### Z.AI (GLM)

- Leverantör: `zai`
- Autentisering: `ZAI_API_KEY`
- Exempelmodell: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Alias: `z.ai/*` och `z-ai/*` normaliseras till `zai/*`

### Vercel AI Gateway

- Leverantör: `vercel-ai-gateway`
- Autentisering: `AI_GATEWAY_API_KEY`
- Exempelmodell: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Andra inbyggda leverantörer

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Exempelmodell: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - GLM-modeller på Cerebras använder id:n `zai-glm-4.7` och `zai-glm-4.6`.
  - OpenAI-kompatibel bas-URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Leverantörer via `models.providers` (anpassad/bas-URL)

Använd `models.providers` (eller `models.json`) för att lägga till **anpassade** leverantörer eller
OpenAI-/Anthropic‑kompatibla proxys.

### Moonshot AI (Kimi)

Moonshot använder OpenAI-kompatibla endpoints, så konfigurera den som en anpassad leverantör:

- Leverantör: `moonshot`
- Autentisering: `MOONSHOT_API_KEY`
- Exempelmodell: `moonshot/kimi-k2.5`

Kimi K2-modell-ID:n:

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

Kimi Coding använder Moonshot AI:s Anthropic-kompatibla endpoint:

- Leverantör: `kimi-coding`
- Autentisering: `KIMI_API_KEY`
- Exempelmodell: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (gratisnivå)

Qwen tillhandahåller OAuth-åtkomst till Qwen Coder + Vision via ett device-code-flöde.
Aktivera det medföljande pluginet och logga sedan in:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Modellreferenser:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Se [/providers/qwen](/providers/qwen) för installationsdetaljer och noteringar.

### Synthetic

Synthetic tillhandahåller Anthropic-kompatibla modeller bakom leverantören `synthetic`:

- Leverantör: `synthetic`
- Autentisering: `SYNTHETIC_API_KEY`
- Exempelmodell: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax konfigureras via `models.providers` eftersom den använder anpassade endpoints:

- MiniMax (Anthropic‑kompatibel): `--auth-choice minimax-api`
- Autentisering: `MINIMAX_API_KEY`

Se [/providers/minimax](/providers/minimax) för installationsdetaljer, modellalternativ och konfigutdrag.

### Ollama

Ollama är en lokal LLM-körtid som tillhandahåller ett OpenAI-kompatibelt API:

- Leverantör: `ollama`
- Autentisering: Ingen krävs (lokal server)
- Exempelmodell: `ollama/llama3.3`
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

Ollama upptäcks automatiskt vid lokal körning på `http://127.0.0.1:11434/v1`. Se [/providers/ollama](/providers/ollama) för modellrekommendationer och anpassad konfiguration.

### Lokala proxys (LM Studio, vLLM, LiteLLM, m.fl.)

Exempel (OpenAI‑kompatibel):

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

Noteringar:

- För anpassade leverantörer är `reasoning`, `input`, `cost`, `contextWindow` och `maxTokens` valfria.
  När de utelämnas använder OpenClaw som standard:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Rekommenderat: ange explicita värden som matchar din proxy/modells gränser.

## CLI-exempel

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Se även: [/gateway/configuration](/gateway/configuration) för fullständiga konfigurationsexempel.
