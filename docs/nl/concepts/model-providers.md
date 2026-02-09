---
summary: "Overzicht van modelproviders met voorbeeldconfiguraties + CLI-flows"
read_when:
  - Je hebt een provider-voor-provider referentie voor modelinstallatie nodig
  - Je wilt voorbeeldconfiguraties of CLI-onboardingopdrachten voor modelproviders
title: "Modelproviders"
---

# Modelproviders

Deze pagina behandelt **LLM-/modelproviders** (geen chatkanalen zoals WhatsApp/Telegram).
Zie [/concepts/models](/concepts/models) voor regels voor modelselectie.

## Snelle regels

- Modelreferenties gebruiken `provider/model` (voorbeeld: `opencode/claude-opus-4-6`).
- Als je `agents.defaults.models` instelt, wordt dit de toegestane lijst.
- CLI-hulpprogramma's: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Ingebouwde providers (pi-ai-catalogus)

OpenClaw wordt geleverd met de pi‑ai-catalogus. Deze providers vereisen **geen**
`models.providers`-configuratie; stel alleen authenticatie in en kies een model.

### OpenAI

- Provider: `openai`
- Auth: `OPENAI_API_KEY`
- Voorbeeldmodel: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Provider: `anthropic`
- Auth: `ANTHROPIC_API_KEY` of `claude setup-token`
- Voorbeeldmodel: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (plak setup-token) of `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Provider: `openai-codex`
- Auth: OAuth (ChatGPT)
- Voorbeeldmodel: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` of `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Provider: `opencode`
- Auth: `OPENCODE_API_KEY` (of `OPENCODE_ZEN_API_KEY`)
- Voorbeeldmodel: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API-sleutel)

- Provider: `google`
- Auth: `GEMINI_API_KEY`
- Voorbeeldmodel: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity en Gemini CLI

- Providers: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Auth: Vertex gebruikt gcloud ADC; Antigravity/Gemini CLI gebruiken hun respectieve authenticatiestromen
- Antigravity OAuth wordt geleverd als een gebundelde plugin (`google-antigravity-auth`, standaard uitgeschakeld).
  - Inschakelen: `openclaw plugins enable google-antigravity-auth`
  - Inloggen: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth wordt geleverd als een gebundelde plugin (`google-gemini-cli-auth`, standaard uitgeschakeld).
  - Inschakelen: `openclaw plugins enable google-gemini-cli-auth`
  - Inloggen: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Let op: je plakt **geen** client-id of -secret in `openclaw.json`. De CLI-inlogstroom slaat
    tokens op in auth-profielen op de Gateway-host.

### Z.AI (GLM)

- Provider: `zai`
- Auth: `ZAI_API_KEY`
- Voorbeeldmodel: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Aliassen: `z.ai/*` en `z-ai/*` normaliseren naar `zai/*`

### Vercel AI Gateway

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- Voorbeeldmodel: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Andere ingebouwde providers

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Voorbeeldmodel: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - GLM-modellen op Cerebras gebruiken id's `zai-glm-4.7` en `zai-glm-4.6`.
  - OpenAI-compatibele basis-URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Providers via `models.providers` (aangepaste/basis-URL)

Gebruik `models.providers` (of `models.json`) om **aangepaste** providers of
OpenAI-/Anthropic-compatibele proxies toe te voegen.

### Moonshot AI (Kimi)

Moonshot gebruikt OpenAI-compatibele endpoints, dus configureer het als een aangepaste provider:

- Provider: `moonshot`
- Auth: `MOONSHOT_API_KEY`
- Voorbeeldmodel: `moonshot/kimi-k2.5`

Kimi K2-model-id's:

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

Kimi Coding gebruikt het Anthropic-compatibele endpoint van Moonshot AI:

- Provider: `kimi-coding`
- Auth: `KIMI_API_KEY`
- Voorbeeldmodel: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (gratis niveau)

Qwen biedt OAuth-toegang tot Qwen Coder + Vision via een device-code-stroom.
Schakel de gebundelde plugin in en log vervolgens in:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Modelreferenties:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Zie [/providers/qwen](/providers/qwen) voor installatiedetails en notities.

### Synthetic

Synthetic biedt Anthropic-compatibele modellen achter de `synthetic`-provider:

- Provider: `synthetic`
- Auth: `SYNTHETIC_API_KEY`
- Voorbeeldmodel: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax wordt geconfigureerd via `models.providers` omdat het aangepaste endpoints gebruikt:

- MiniMax (Anthropic‑compatibel): `--auth-choice minimax-api`
- Auth: `MINIMAX_API_KEY`

Zie [/providers/minimax](/providers/minimax) voor installatiedetails, modelopties en config-fragmenten.

### Ollama

Ollama is een lokale LLM-runtime die een OpenAI-compatibele API biedt:

- Provider: `ollama`
- Auth: Geen vereist (lokale server)
- Voorbeeldmodel: `ollama/llama3.3`
- Installatie: [https://ollama.ai](https://ollama.ai)

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

Ollama wordt automatisch gedetecteerd wanneer lokaal wordt uitgevoerd op `http://127.0.0.1:11434/v1`. Zie [/providers/ollama](/providers/ollama) voor modelaanbevelingen en aangepaste configuratie.

### Lokale proxies (LM Studio, vLLM, LiteLLM, enz.)

Voorbeeld (OpenAI-compatibel):

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

Notities:

- Voor aangepaste providers zijn `reasoning`, `input`, `cost`, `contextWindow` en `maxTokens` optioneel.
  Wanneer weggelaten, gebruikt OpenClaw standaard:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Aanbevolen: stel expliciete waarden in die overeenkomen met de limieten van je proxy/model.

## CLI-voorbeelden

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Zie ook: [/gateway/configuration](/gateway/configuration) voor volledige configuratievoorbeelden.
