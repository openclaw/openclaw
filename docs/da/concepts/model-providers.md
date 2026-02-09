---
summary: "Overblik over modeludbydere med eksempelkonfigurationer + CLI-flows"
read_when:
  - Du har brug for en udbyder-for-udbyder reference til modelopsætning
  - Du vil have eksempelkonfigurationer eller CLI-introduktionskommandoer for modeludbydere
title: "Modeludbydere"
---

# Modeludbydere

Denne side dækker **LLM/model udbydere** (ikke chat kanaler som WhatsApp/Telegram).
For regler for modelvalg se [/concepts/models](/concepts/models).

## Hurtige regler

- Modelreferencer bruger `provider/model` (eksempel: `opencode/claude-opus-4-6`).
- Hvis du sætter `agents.defaults.models`, bliver det tilladelseslisten.
- CLI-hjælpere: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Indbyggede udbydere (pi-ai-katalog)

OpenClaw skibe med pi-ai katalog. Disse udbydere kræver **nej**
`models.providers` config; sæt bare auth + vælg en model.

### OpenAI

- Udbyder: `openai`
- Autentificering: `OPENAI_API_KEY`
- Eksempelmodel: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Udbyder: `anthropic`
- Autentificering: `ANTHROPIC_API_KEY` eller `claude setup-token`
- Eksempelmodel: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (indsæt setup-token) eller `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Udbyder: `openai-codex`
- Autentificering: OAuth (ChatGPT)
- Eksempelmodel: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` eller `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Udbyder: `opencode`
- Autentificering: `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`)
- Eksempelmodel: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API-nøgle)

- Udbyder: `google`
- Autentificering: `GEMINI_API_KEY`
- Eksempelmodel: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity og Gemini CLI

- Udbydere: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Autentificering: Vertex bruger gcloud ADC; Antigravity/Gemini CLI bruger deres respektive autentificeringsflows
- Antigravity OAuth leveres som et bundtet plugin (`google-antigravity-auth`, deaktiveret som standard).
  - Aktivér: `openclaw plugins enable google-antigravity-auth`
  - Log ind: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth leveres som et bundtet plugin (`google-gemini-cli-auth`, deaktiveret som standard).
  - Aktivér: `openclaw plugins enable google-gemini-cli-auth`
  - Log ind: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Bemærk: du **ikke** indsætter et klient-id eller hemmelig i `openclaw.json`. CLI login-flowet gemmer
    tokens i auth profiler på gateway værten.

### Z.AI (GLM)

- Udbyder: `zai`
- Autentificering: `ZAI_API_KEY`
- Eksempelmodel: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Aliaser: `z.ai/*` og `z-ai/*` normaliseres til `zai/*`

### Vercel AI Gateway

- Udbyder: `vercel-ai-gateway`
- Autentificering: `AI_GATEWAY_API_KEY`
- Eksempelmodel: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Andre indbyggede udbydere

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Eksempelmodel: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - GLM-modeller på Cerebras bruger id’er `zai-glm-4.7` og `zai-glm-4.6`.
  - OpenAI-kompatibel base-URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Udbydere via `models.providers` (brugerdefineret/base-URL)

Brug `models.providers` (eller `models.json`) til at tilføje **brugerdefinerede** udbydere eller
OpenAI-/Anthropic‑kompatible proxier.

### Moonshot AI (Kimi)

Moonshot bruger OpenAI-kompatible endpoints, så konfigurer den som en brugerdefineret udbyder:

- Udbyder: `moonshot`
- Autentificering: `MOONSHOT_API_KEY`
- Eksempelmodel: `moonshot/kimi-k2.5`

Kimi K2-model-id’er:

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

Kimi Coding bruger Moonshot AI’s Anthropic-kompatible endpoint:

- Udbyder: `kimi-coding`
- Autentificering: `KIMI_API_KEY`
- Eksempelmodel: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (gratis niveau)

Qwen giver OAuth adgang til Qwen Coder + Vision via en enheds-kode flow.
Aktiver det bundtede plugin, og log ind:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Modelreferencer:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Se [/providers/qwen](/providers/qwen) for opsætningsdetaljer og noter.

### Synthetic

Synthetic leverer Anthropic-kompatible modeller bag `synthetic`-udbyderen:

- Udbyder: `synthetic`
- Autentificering: `SYNTHETIC_API_KEY`
- Eksempelmodel: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax konfigureres via `models.providers`, fordi den bruger brugerdefinerede endpoints:

- MiniMax (Anthropic‑kompatibel): `--auth-choice minimax-api`
- Autentificering: `MINIMAX_API_KEY`

Se [/providers/minimax](/providers/minimax) for opsætningsdetaljer, modelmuligheder og konfigurationsudsnit.

### Ollama

Ollama er et lokalt LLM-runtime, der leverer et OpenAI-kompatibelt API:

- Udbyder: `ollama`
- Autentificering: Ingen påkrævet (lokal server)
- Eksempelmodel: `ollama/llama3.3`
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

Ollama registreres automatisk, når du kører lokalt på `http://127.0.0.1:11434/v1`. Se [/providers/ollama](/providers/ollama) for modelanbefalinger og brugerdefineret konfiguration.

### Lokale proxier (LM Studio, vLLM, LiteLLM osv.)

Eksempel (OpenAI‑kompatibel):

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

Noter:

- For brugerdefinerede udbydere, `argumentation`, `input`, `cost`, `contextWindow`, og `maxTokens` er valgfri.
  Når udeladt, har OpenClaw misligholdt:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Anbefalet: angiv eksplicitte værdier, der matcher din proxy/models begrænsninger.

## CLI-eksempler

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Se også: [/gateway/configuration](/gateway/configuration) for fulde konfigurationseksempler.
