---
summary: "Proveedores de modelos (LLMs) soportados por OpenClaw"
read_when:
  - Quieres elegir un proveedor de modelo
  - Necesitas una vista general rápida de los backends LLM soportados
title: "Proveedores de Modelos"
---

# Proveedores de Modelos

OpenClaw puede usar muchos proveedores de LLM. Elige un proveedor, autentica y luego establece el modelo por defecto como `provider/model`.

¿Buscas documentación de canales de chat (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? Ver [Canales](/es-ES/channels).

## Destacado: Venice (Venice AI)

Venice es nuestra configuración recomendada de Venice AI para inferencia que prioriza la privacidad con opción de usar Opus para tareas difíciles.

- Por defecto: `venice/llama-3.3-70b`
- Mejor en general: `venice/claude-opus-45` (Opus sigue siendo el más potente)

Ver [Venice AI](/es-ES/providers/venice).

## Inicio rápido

1. Autentica con el proveedor (usualmente mediante `openclaw onboard`).
2. Establece el modelo por defecto:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Documentación de proveedores

- [OpenAI (API + Codex)](/es-ES/providers/openai)
- [Anthropic (API + CLI de Claude Code)](/es-ES/providers/anthropic)
- [Qwen (OAuth)](/es-ES/providers/qwen)
- [OpenRouter](/es-ES/providers/openrouter)
- [LiteLLM (gateway unificado)](/es-ES/providers/litellm)
- [Vercel AI Gateway](/es-ES/providers/vercel-ai-gateway)
- [Together AI](/es-ES/providers/together)
- [Cloudflare AI Gateway](/es-ES/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/es-ES/providers/moonshot)
- [OpenCode Zen](/es-ES/providers/opencode)
- [Amazon Bedrock](/es-ES/providers/bedrock)
- [Z.AI](/es-ES/providers/zai)
- [Xiaomi](/es-ES/providers/xiaomi)
- [Modelos GLM](/es-ES/providers/glm)
- [MiniMax](/es-ES/providers/minimax)
- [Venice (Venice AI, enfocado en privacidad)](/es-ES/providers/venice)
- [Hugging Face (Inference)](/es-ES/providers/huggingface)
- [Ollama (modelos locales)](/es-ES/providers/ollama)
- [vLLM (modelos locales)](/es-ES/providers/vllm)
- [Qianfan](/es-ES/providers/qianfan)
- [NVIDIA](/es-ES/providers/nvidia)

## Proveedores de transcripción

- [Deepgram (transcripción de audio)](/es-ES/providers/deepgram)

## Herramientas de la comunidad

- [Claude Max API Proxy](/es-ES/providers/claude-max-api-proxy) - Usa la suscripción de Claude Max/Pro como un endpoint de API compatible con OpenAI

Para el catálogo completo de proveedores (xAI, Groq, Mistral, etc.) y configuración avanzada,
ver [Proveedores de modelos](/es-ES/concepts/model-providers).
