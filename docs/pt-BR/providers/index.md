---
summary: "Provedores de modelo (LLMs) compatíveis com o OpenClaw"
read_when:
  - Você quer escolher um provedor de modelo
  - Você precisa de uma visão geral rápida dos backends de LLM compatíveis
title: "Provedores de modelo"
---

# Provedores de modelo

O OpenClaw pode usar muitos provedores de LLM. Escolha um provedor, autentique-se e, em seguida, defina o
modelo padrão como `provider/model`.

Procurando documentação de canais de chat (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? Veja [Canais](/channels).

## Destaque: Venice (Venice AI)

Venice é nossa configuração recomendada do Venice AI para inferência com foco em privacidade, com a opção de usar o Opus para tarefas difíceis.

- Padrão: `venice/llama-3.3-70b`
- Melhor no geral: `venice/claude-opus-45` (o Opus continua sendo o mais forte)

Veja [Venice AI](/providers/venice).

## Início rápido

1. Autentique-se com o provedor (geralmente via `openclaw onboard`).
2. Defina o modelo padrão:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Documentação dos provedores

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [Modelos GLM](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, com foco em privacidade)](/providers/venice)
- [Ollama (modelos locais)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Provedores de transcrição

- [Deepgram (transcrição de áudio)](/providers/deepgram)

## Ferramentas da comunidade

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Use a assinatura Claude Max/Pro como um endpoint de API compatível com OpenAI

Para o catálogo completo de provedores (xAI, Groq, Mistral, etc.) e configuração avançada,
veja [Provedores de modelo](/concepts/model-providers).
