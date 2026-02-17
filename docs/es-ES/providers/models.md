---
summary: "Proveedores de modelos (LLMs) soportados por OpenClaw"
read_when:
  - Quieres elegir un proveedor de modelo
  - Quieres ejemplos rápidos de configuración para autenticación LLM + selección de modelo
title: "Inicio Rápido de Proveedores de Modelos"
---

# Proveedores de Modelos

OpenClaw puede usar muchos proveedores de LLM. Elige uno, autentica y luego establece el modelo por defecto como `provider/model`.

## Destacado: Venice (Venice AI)

Venice es nuestra configuración recomendada de Venice AI para inferencia que prioriza la privacidad con opción de usar Opus para las tareas más difíciles.

- Por defecto: `venice/llama-3.3-70b`
- Mejor en general: `venice/claude-opus-45` (Opus sigue siendo el más potente)

Ver [Venice AI](/es-ES/providers/venice).

## Inicio rápido (dos pasos)

1. Autentica con el proveedor (usualmente mediante `openclaw onboard`).
2. Establece el modelo por defecto:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Proveedores soportados (conjunto inicial)

- [OpenAI (API + Codex)](/es-ES/providers/openai)
- [Anthropic (API + CLI de Claude Code)](/es-ES/providers/anthropic)
- [OpenRouter](/es-ES/providers/openrouter)
- [Vercel AI Gateway](/es-ES/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/es-ES/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/es-ES/providers/moonshot)
- [Synthetic](/es-ES/providers/synthetic)
- [OpenCode Zen](/es-ES/providers/opencode)
- [Z.AI](/es-ES/providers/zai)
- [Modelos GLM](/es-ES/providers/glm)
- [MiniMax](/es-ES/providers/minimax)
- [Venice (Venice AI)](/es-ES/providers/venice)
- [Amazon Bedrock](/es-ES/providers/bedrock)
- [Qianfan](/es-ES/providers/qianfan)

Para el catálogo completo de proveedores (xAI, Groq, Mistral, etc.) y configuración avanzada,
ver [Proveedores de modelos](/es-ES/concepts/model-providers).
