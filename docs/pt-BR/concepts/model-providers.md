---
summary: "Visão geral de provedor de modelo com configs de exemplo + fluxos CLI"
read_when:
  - Você precisa de uma referência de setup de modelo por provedor
  - Você quer configs de exemplo ou comandos de onboarding CLI para provedores de modelo
title: "Provedores de Modelo"
---

# Provedores de modelo

Essa página cobre **provedores de modelo/LLM** (não canais de chat como WhatsApp/Telegram).
Para regras de seleção de modelo, veja [/pt-BR/concepts/models](/pt-BR/concepts/models).

## Regras rápidas

- Referências de modelo usam `provider/model` (exemplo: `opencode/claude-opus-4-6`).
- Se você definir `agents.defaults.models`, ele se torna a lista de permissões.
- Helpers de CLI: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Provedores integrados (catálogo pi-ai)

OpenClaw é enviado com o catálogo pi-ai. Esses provedores **não** requerem config `models.providers`; apenas defina autenticação + escolha um modelo.

### OpenAI

- Provedor: `openai`
- Autenticação: `OPENAI_API_KEY`
- Modelo de exemplo: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Provedor: `anthropic`
- Autenticação: `ANTHROPIC_API_KEY` ou `claude setup-token`
- Modelo de exemplo: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (cola setup-token) ou `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Provedor: `openai-codex`
- Autenticação: OAuth (ChatGPT)
- Modelo de exemplo: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` ou `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Provedor: `opencode`
- Autenticação: `OPENCODE_API_KEY` (ou `OPENCODE_ZEN_API_KEY`)
- Modelo de exemplo: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- Provedor: `google`
- Autenticação: `GEMINI_API_KEY`
- Modelo de exemplo: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity e Gemini CLI

- Provedores: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Autenticação: Vertex usa gcloud ADC; Antigravity/Gemini CLI usam seus fluxos de autenticação respectivos
- OAuth de Antigravidade é enviado como plugin agrupado (`google-antigravity-auth`, desabilitado por padrão).
  - Habilite: `openclaw plugins enable google-antigravity-auth`
  - Login: `openclaw models auth login --provider google-antigravity --set-default`
- OAuth Gemini CLI é enviado como plugin agrupado (`google-gemini-cli-auth`, desabilitado por padrão).
  - Habilite: `openclaw plugins enable google-gemini-cli-auth`
  - Login: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Nota: você **não** cola um client id ou secret em `openclaw.json`. O fluxo de login de CLI armazena tokens em perfis de autenticação no host do gateway.

### Z.AI (GLM)

- Provedor: `zai`
- Autenticação: `ZAI_API_KEY`
- Modelo de exemplo: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Aliases: `z.ai/*` e `z-ai/*` normalizam para `zai/*`

### Vercel AI Gateway

- Provedor: `vercel-ai-gateway`
- Autenticação: `AI_GATEWAY_API_KEY`
- Modelo de exemplo: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Outros provedores integrados

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Modelo de exemplo: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Modelos GLM em Cerebras usam ids `zai-glm-4.7` e `zai-glm-4.6`.
  - URL base compatível com OpenAI: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face Inference: `huggingface` (`HUGGINGFACE_HUB_TOKEN` ou `HF_TOKEN`) — roteador compatível com OpenAI; modelo de exemplo: `huggingface/deepseek-ai/DeepSeek-R1`; CLI: `openclaw onboard --auth-choice huggingface-api-key`. Veja [Hugging Face (Inference)](/providers/huggingface).

## Provedores via `models.providers` (customizado/URL base)

Use `models.providers` (ou `models.json`) para adicionar provedores **customizados** ou proxies compatíveis com OpenAI/Anthropic.
