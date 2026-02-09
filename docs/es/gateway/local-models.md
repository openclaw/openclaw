---
summary: "Ejecute OpenClaw en LLM locales (LM Studio, vLLM, LiteLLM, endpoints personalizados compatibles con OpenAI)"
read_when:
  - Quiere servir modelos desde su propio equipo con GPU
  - Está conectando LM Studio o un proxy compatible con OpenAI
  - Necesita la guía más segura para modelos locales
title: "Modelos locales"
---

# Modelos locales

Lo local es viable, pero OpenClaw espera un contexto grande y defensas sólidas contra la inyección de prompts. Las tarjetas pequeñas truncan el contexto y filtran seguridad. Apunte alto: **≥2 Mac Studios al máximo o un equipo de GPU equivalente (~USD $30k+)**. Una sola GPU de **24 GB** funciona solo para prompts más ligeros con mayor latencia. Use la **variante de modelo más grande / de tamaño completo que pueda ejecutar**; los checkpoints agresivamente cuantizados o “pequeños” elevan el riesgo de inyección de prompts (ver [Security](/gateway/security)).

## Recomendado: LM Studio + MiniMax M2.1 (Responses API, tamaño completo)

El mejor stack local actual. Cargue MiniMax M2.1 en LM Studio, habilite el servidor local (predeterminado `http://127.0.0.1:1234`), y use Responses API para mantener el razonamiento separado del texto final.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**Lista de verificación de configuración**

- Instale LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- En LM Studio, descargue la **compilación más grande de MiniMax M2.1 disponible** (evite variantes “small”/fuertemente cuantizadas), inicie el servidor y confirme que `http://127.0.0.1:1234/v1/models` lo lista.
- Mantenga el modelo cargado; la carga en frío agrega latencia de arranque.
- Ajuste `contextWindow`/`maxTokens` si su compilación de LM Studio difiere.
- Para WhatsApp, manténgase en Responses API para que solo se envíe el texto final.

Mantenga los modelos alojados configurados incluso al ejecutar localmente; use `models.mode: "merge"` para que los fallbacks sigan disponibles.

### Configuración híbrida: principal alojado, fallback local

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Prioridad local con red de seguridad alojada

Intercambie el orden de principal y fallback; mantenga el mismo bloque de proveedores y `models.mode: "merge"` para poder volver a Sonnet u Opus cuando el equipo local esté fuera de servicio.

### Alojamiento regional / enrutamiento de datos

- También existen variantes alojadas de MiniMax/Kimi/GLM en OpenRouter con endpoints fijados por región (p. ej., alojados en EE. Elija allí la variante regional para mantener el tráfico en su jurisdicción elegida mientras sigue usando `models.mode: "merge"` como fallback de Anthropic/OpenAI.
- Solo local sigue siendo la vía de mayor privacidad; el enrutamiento regional alojado es el punto intermedio cuando necesita funciones del proveedor pero quiere controlar el flujo de datos.

## Otros proxies locales compatibles con OpenAI

vLLM, LiteLLM, OAI-proxy o Gateways personalizados funcionan si exponen un endpoint `/v1` al estilo OpenAI. Reemplace el bloque de proveedor anterior con su endpoint y el ID del modelo:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Mantenga `models.mode: "merge"` para que los modelos alojados sigan disponibles como fallbacks.

## Solución de problemas

- ¿El Gateway puede alcanzar el proxy? `curl http://127.0.0.1:1234/v1/models`.
- ¿Modelo de LM Studio descargado de memoria? Vuelva a cargarlo; el inicio en frío es una causa común de “bloqueo”.
- ¿Errores de contexto? Baje `contextWindow` o aumente el límite de su servidor.
- Seguridad: los modelos locales omiten los filtros del proveedor; mantenga los agentes acotados y la compactación activada para limitar el radio de impacto de la inyección de prompts.
