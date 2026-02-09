---
summary: "Vue d’ensemble des fournisseurs de modèles avec des exemples de configurations + des flux CLI"
read_when:
  - Vous avez besoin d’une reference de configuration des modeles, fournisseur par fournisseur
  - Vous voulez des exemples de configurations ou des commandes CLI de prise en main pour les fournisseurs de modeles
title: "Fournisseurs de modeles"
---

# Fournisseurs de modeles

Cette page couvre les **fournisseurs de LLM/modeles** (et non les canaux de chat comme WhatsApp/Telegram).
Pour les regles de selection des modeles, voir [/concepts/models](/concepts/models).

## Regles rapides

- Les references de modeles utilisent `provider/model` (exemple : `opencode/claude-opus-4-6`).
- Si vous definissez `agents.defaults.models`, cela devient la liste d’autorisation.
- Assistants CLI : `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Fournisseurs integres (catalogue pi‑ai)

OpenClaw est fourni avec le catalogue pi‑ai. Ces fournisseurs ne necessitent **aucune**
configuration `models.providers` ; il suffit de definir l’authentification et de choisir un modele.

### OpenAI

- Fournisseur : `openai`
- Authentification : `OPENAI_API_KEY`
- Exemple de modele : `openai/gpt-5.1-codex`
- CLI : `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Fournisseur : `anthropic`
- Authentification : `ANTHROPIC_API_KEY` ou `claude setup-token`
- Exemple de modele : `anthropic/claude-opus-4-6`
- CLI : `openclaw onboard --auth-choice token` (coller le setup-token) ou `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Fournisseur : `openai-codex`
- Authentification : OAuth (ChatGPT)
- Exemple de modele : `openai-codex/gpt-5.3-codex`
- CLI : `openclaw onboard --auth-choice openai-codex` ou `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Fournisseur : `opencode`
- Authentification : `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`)
- Exemple de modele : `opencode/claude-opus-4-6`
- CLI : `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (cle API)

- Fournisseur : `google`
- Authentification : `GEMINI_API_KEY`
- Exemple de modele : `google/gemini-3-pro-preview`
- CLI : `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity et Gemini CLI

- Fournisseurs : `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Authentification : Vertex utilise gcloud ADC ; Antigravity/Gemini CLI utilisent leurs flux d’authentification respectifs
- L’OAuth Antigravity est fourni comme plugin groupe (`google-antigravity-auth`, desactive par defaut).
  - Activer : `openclaw plugins enable google-antigravity-auth`
  - Connexion : `openclaw models auth login --provider google-antigravity --set-default`
- L’OAuth Gemini CLI est fourni comme plugin groupe (`google-gemini-cli-auth`, desactive par defaut).
  - Activer : `openclaw plugins enable google-gemini-cli-auth`
  - Connexion : `openclaw models auth login --provider google-gemini-cli --set-default`
  - Remarque : vous ne collez **pas** d’identifiant client ni de secret dans `openclaw.json`. Le flux de connexion CLI stocke
    les jetons dans des profils d’authentification sur l’hote de la Gateway (passerelle).

### Z.AI (GLM)

- Fournisseur : `zai`
- Authentification : `ZAI_API_KEY`
- Exemple de modele : `zai/glm-4.7`
- CLI : `openclaw onboard --auth-choice zai-api-key`
  - Alias : `z.ai/*` et `z-ai/*` sont normalises vers `zai/*`

### Vercel AI Gateway

- Fournisseur : `vercel-ai-gateway`
- Authentification : `AI_GATEWAY_API_KEY`
- Exemple de modele : `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI : `openclaw onboard --auth-choice ai-gateway-api-key`

### Autres fournisseurs integres

- OpenRouter : `openrouter` (`OPENROUTER_API_KEY`)
- Exemple de modele : `openrouter/anthropic/claude-sonnet-4-5`
- xAI : `xai` (`XAI_API_KEY`)
- Groq : `groq` (`GROQ_API_KEY`)
- Cerebras : `cerebras` (`CEREBRAS_API_KEY`)
  - Les modeles GLM sur Cerebras utilisent les identifiants `zai-glm-4.7` et `zai-glm-4.6`.
  - URL de base compatible OpenAI : `https://api.cerebras.ai/v1`.
- Mistral : `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot : `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Fournisseurs via `models.providers` (URL personnalisee/de base)

Utilisez `models.providers` (ou `models.json`) pour ajouter des fournisseurs **personnalises** ou
des proxys compatibles OpenAI/Anthropic.

### Moonshot AI (Kimi)

Moonshot utilise des endpoints compatibles OpenAI ; configurez-le donc comme un fournisseur personnalise :

- Fournisseur : `moonshot`
- Authentification : `MOONSHOT_API_KEY`
- Exemple de modele : `moonshot/kimi-k2.5`

Identifiants de modeles Kimi K2 :

{/_ moonshot-kimi-k2-model-refs:start _/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_ moonshot-kimi-k2-model-refs:end _/ && null}

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

Kimi Coding utilise l’endpoint compatible Anthropic de Moonshot AI :

- Fournisseur : `kimi-coding`
- Authentification : `KIMI_API_KEY`
- Exemple de modele : `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (offre gratuite)

Qwen fournit un acces OAuth a Qwen Coder + Vision via un flux device-code.
Activez le plugin groupe, puis connectez-vous :

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

References de modeles :

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Voir [/providers/qwen](/providers/qwen) pour les details de configuration et les remarques.

### Synthetic

Synthetic fournit des modeles compatibles Anthropic derriere le fournisseur `synthetic` :

- Fournisseur : `synthetic`
- Authentification : `SYNTHETIC_API_KEY`
- Exemple de modele : `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI : `openclaw onboard --auth-choice synthetic-api-key`

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

MiniMax est configure via `models.providers` car il utilise des endpoints personnalises :

- MiniMax (compatible Anthropic) : `--auth-choice minimax-api`
- Authentification : `MINIMAX_API_KEY`

Voir [/providers/minimax](/providers/minimax) pour les details de configuration, les options de modeles et des extraits de configuration.

### Ollama

Ollama est un runtime LLM local qui fournit une API compatible OpenAI :

- Fournisseur : `ollama`
- Authentification : aucune requise (serveur local)
- Exemple de modele : `ollama/llama3.3`
- Installation : https://ollama.ai

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

Ollama est detecte automatiquement lorsqu’il s’execute localement a `http://127.0.0.1:11434/v1`. Voir [/providers/ollama](/providers/ollama) pour des recommandations de modeles et une configuration personnalisee.

### Proxys locaux (LM Studio, vLLM, LiteLLM, etc.)

Exemple (compatible OpenAI) :

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

Remarques :

- Pour les fournisseurs personnalises, `reasoning`, `input`, `cost`, `contextWindow` et `maxTokens` sont facultatifs.
  Lorsqu’ils sont omis, OpenClaw utilise par defaut :
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Recommande : definir des valeurs explicites correspondant aux limites de votre proxy/modele.

## Exemples CLI

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Voir aussi : [/gateway/configuration](/gateway/configuration) pour des exemples de configuration complets.
