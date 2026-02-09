---
summary: "Proveedores de modelos (LLM) compatibles con OpenClaw"
read_when:
  - Quiere elegir un proveedor de modelos
  - Necesita una visión general rápida de los backends de LLM compatibles
title: "Proveedores de modelos"
---

# Proveedores de modelos

OpenClaw puede usar muchos proveedores de LLM. Elija un proveedor, autentíquese y luego establezca el
modelo predeterminado como `provider/model`.

¿Busca documentación de canales de chat (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? Consulte [Canales](/channels).

## Destacado: Venice (Venice AI)

Venice es nuestra configuración recomendada de Venice AI para inferencia con prioridad en la privacidad, con la opción de usar Opus para tareas difíciles.

- Predeterminado: `venice/llama-3.3-70b`
- Mejor en general: `venice/claude-opus-45` (Opus sigue siendo el más fuerte)

Consulte [Venice AI](/providers/venice).

## Inicio rápido

1. Autentíquese con el proveedor (generalmente mediante `openclaw onboard`).
2. Establezca el modelo predeterminado:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Documentación de proveedores

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
- [Venice (Venice AI, con enfoque en la privacidad)](/providers/venice)
- [Ollama (modelos locales)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Proveedores de transcripción

- [Deepgram (transcripción de audio)](/providers/deepgram)

## Herramientas de la comunidad

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Use una suscripción Claude Max/Pro como un endpoint de API compatible con OpenAI

Para el catálogo completo de proveedores (xAI, Groq, Mistral, etc.) y la configuración avanzada,
consulte [Proveedores de modelos](/concepts/model-providers).
