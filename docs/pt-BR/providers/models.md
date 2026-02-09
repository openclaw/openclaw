---
summary: "Provedores de modelo (LLMs) compatíveis com o OpenClaw"
read_when:
  - Você quer escolher um provedor de modelo
  - Você quer exemplos de configuração rápida para autenticação de LLM + seleção de modelo
title: "Início rápido de provedores de modelo"
---

# Provedores de modelo

O OpenClaw pode usar muitos provedores de LLM. Escolha um, autentique e, em seguida, defina o
modelo padrão como `provider/model`.

## Destaque: Venice (Venice AI)

Venice é nossa configuração recomendada do Venice AI para inferência com foco em privacidade, com a opção de usar Opus para as tarefas mais difíceis.

- Padrão: `venice/llama-3.3-70b`
- Melhor no geral: `venice/claude-opus-45` (Opus continua sendo o mais forte)

Veja [Venice AI](/providers/venice).

## Início rápido (dois passos)

1. Autentique-se com o provedor (geralmente via `openclaw onboard`).
2. Defina o modelo padrão:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Provedores compatíveis (conjunto inicial)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [Modelos GLM](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

Para o catálogo completo de provedores (xAI, Groq, Mistral etc.) e configuração avançada,
veja [Provedores de modelo](/concepts/model-providers).
