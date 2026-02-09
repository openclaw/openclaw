---
summary: "Proveedores de modelos (LLM) compatibles con OpenClaw"
read_when:
  - Quiere elegir un proveedor de modelos
  - Quiere ejemplos de configuración rápida para la autenticación de LLM y la selección de modelos
title: "Inicio rápido de proveedores de modelos"
---

# Proveedores de modelos

OpenClaw puede usar muchos proveedores de LLM. Elija uno, autentíquese y luego configure el
modelo predeterminado como `provider/model`.

## Destacado: Venice (Venice AI)

Venice es nuestra configuración recomendada de Venice AI para inferencia con enfoque en la privacidad, con la opción de usar Opus para las tareas más difíciles.

- Predeterminado: `venice/llama-3.3-70b`
- Mejor en general: `venice/claude-opus-45` (Opus sigue siendo el más sólido)

Vea [Venice AI](/providers/venice).

## Inicio rápido (dos pasos)

1. Autentíquese con el proveedor (generalmente mediante `openclaw onboard`).
2. Configure el modelo predeterminado:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Proveedores compatibles (conjunto inicial)

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

Para el catálogo completo de proveedores (xAI, Groq, Mistral, etc.) y la configuración avanzada,
consulte [Proveedores de modelos](/concepts/model-providers).
