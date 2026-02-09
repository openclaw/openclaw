---
summary: "Przegląd dostawców modeli z przykładowymi konfiguracjami i przepływami CLI"
read_when:
  - Potrzebujesz referencji konfiguracji modeli według dostawców
  - Chcesz zobaczyć przykładowe konfiguracje lub polecenia CLI do onboardingu dostawców modeli
title: "Dostawcy modeli"
---

# Dostawcy modeli

Ta strona obejmuje **dostawców LLM/modeli** (nie kanały czatu, takie jak WhatsApp/Telegram).
Zasady wyboru modeli opisano w [/concepts/models](/concepts/models).

## Szybkie zasady

- Odwołania do modeli używają `provider/model` (przykład: `opencode/claude-opus-4-6`).
- Jeśli ustawisz `agents.defaults.models`, staje się on listą dozwolonych.
- Pomocniki CLI: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Wbudowani dostawcy (katalog pi‑ai)

OpenClaw jest dostarczany z katalogiem pi‑ai. Ci dostawcy **nie wymagają**
konfiguracji `models.providers`; wystarczy ustawić uwierzytelnianie i wybrać model.

### OpenAI

- Dostawca: `openai`
- Uwierzytelnianie: `OPENAI_API_KEY`
- Przykładowy model: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Dostawca: `anthropic`
- Uwierzytelnianie: `ANTHROPIC_API_KEY` lub `claude setup-token`
- Przykładowy model: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (wklej setup-token) lub `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Dostawca: `openai-codex`
- Uwierzytelnianie: OAuth (ChatGPT)
- Przykładowy model: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` lub `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Dostawca: `opencode`
- Uwierzytelnianie: `OPENCODE_API_KEY` (lub `OPENCODE_ZEN_API_KEY`)
- Przykładowy model: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (klucz API)

- Dostawca: `google`
- Uwierzytelnianie: `GEMINI_API_KEY`
- Przykładowy model: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity i Gemini CLI

- Dostawcy: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Uwierzytelnianie: Vertex używa gcloud ADC; Antigravity/Gemini CLI używają własnych przepływów uwierzytelniania
- OAuth Antigravity jest dostarczany jako dołączona wtyczka (`google-antigravity-auth`, domyślnie wyłączona).
  - Włącz: `openclaw plugins enable google-antigravity-auth`
  - Logowanie: `openclaw models auth login --provider google-antigravity --set-default`
- OAuth Gemini CLI jest dostarczany jako dołączona wtyczka (`google-gemini-cli-auth`, domyślnie wyłączona).
  - Włącz: `openclaw plugins enable google-gemini-cli-auth`
  - Logowanie: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Uwaga: **nie** wkleja się identyfikatora klienta ani sekretu do `openclaw.json`. Przepływ logowania CLI zapisuje
    tokeny w profilach uwierzytelniania na hoście Gateway.

### Z.AI (GLM)

- Dostawca: `zai`
- Uwierzytelnianie: `ZAI_API_KEY`
- Przykładowy model: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Aliasy: `z.ai/*` i `z-ai/*` normalizują się do `zai/*`

### Vercel AI Gateway

- Dostawca: `vercel-ai-gateway`
- Uwierzytelnianie: `AI_GATEWAY_API_KEY`
- Przykładowy model: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Inni wbudowani dostawcy

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Przykładowy model: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Modele GLM na Cerebras używają identyfikatorów `zai-glm-4.7` oraz `zai-glm-4.6`.
  - Bazowy URL zgodny z OpenAI: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Dostawcy przez `models.providers` (niestandardowy/bazowy URL)

Użyj `models.providers` (lub `models.json`), aby dodać **niestandardowych** dostawców lub
proxy zgodne z OpenAI/Anthropic.

### Moonshot AI (Kimi)

Moonshot korzysta z endpointów zgodnych z OpenAI, dlatego skonfiguruj go jako dostawcę niestandardowego:

- Dostawca: `moonshot`
- Uwierzytelnianie: `MOONSHOT_API_KEY`
- Przykładowy model: `moonshot/kimi-k2.5`

Identyfikatory modeli Kimi K2:

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

Kimi Coding korzysta z endpointu Moonshot AI zgodnego z Anthropic:

- Dostawca: `kimi-coding`
- Uwierzytelnianie: `KIMI_API_KEY`
- Przykładowy model: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (warstwa bezpłatna)

Qwen zapewnia dostęp OAuth do Qwen Coder + Vision poprzez przepływ device‑code.
Włącz dołączoną wtyczkę, a następnie zaloguj się:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Odwołania do modeli:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Szczegóły konfiguracji i uwagi znajdziesz w [/providers/qwen](/providers/qwen).

### Synthetic

Synthetic udostępnia modele zgodne z Anthropic za pośrednictwem dostawcy `synthetic`:

- Dostawca: `synthetic`
- Uwierzytelnianie: `SYNTHETIC_API_KEY`
- Przykładowy model: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax jest konfigurowany przez `models.providers`, ponieważ używa niestandardowych endpointów:

- MiniMax (zgodny z Anthropic): `--auth-choice minimax-api`
- Uwierzytelnianie: `MINIMAX_API_KEY`

Szczegóły konfiguracji, opcje modeli i fragmenty konfiguracji znajdziesz w [/providers/minimax](/providers/minimax).

### Ollama

Ollama to lokalne środowisko uruchomieniowe LLM, które udostępnia API zgodne z OpenAI:

- Dostawca: `ollama`
- Uwierzytelnianie: brak (serwer lokalny)
- Przykładowy model: `ollama/llama3.3`
- Instalacja: [https://ollama.ai](https://ollama.ai)

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

Ollama jest automatycznie wykrywana podczas lokalnego uruchamiania pod adresem `http://127.0.0.1:11434/v1`. Zalecenia dotyczące modeli i konfigurację niestandardową znajdziesz w [/providers/ollama](/providers/ollama).

### Lokalne proxy (LM Studio, vLLM, LiteLLM itd.)

Przykład (zgodny z OpenAI):

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

Uwagi:

- Dla dostawców niestandardowych pola `reasoning`, `input`, `cost`, `contextWindow` oraz `maxTokens` są opcjonalne.
  Gdy zostaną pominięte, OpenClaw domyślnie ustawia:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Zalecane: ustaw jawne wartości odpowiadające limitom Twojego proxy/modelu.

## Przykłady CLI

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Zobacz także: [/gateway/configuration](/gateway/configuration), aby zapoznać się z pełnymi przykładami konfiguracji.
