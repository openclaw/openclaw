---
summary: "Ejecuta OpenClaw en LLMs locales (LM Studio, vLLM, LiteLLM, endpoints OpenAI personalizados)"
read_when:
  - Quieres servir modelos desde tu propio equipo con GPU
  - Estás configurando LM Studio o un proxy compatible con OpenAI
  - Necesitas la guía más segura para modelos locales
title: "Modelos Locales"
---

# Modelos locales

Lo local es factible, pero OpenClaw espera contextos grandes y defensas sólidas contra inyección de prompts. Las tarjetas pequeñas truncan el contexto y comprometen la seguridad. Apunta alto: **≥2 Mac Studios maximizados o un equipo GPU equivalente (~$30k+)**. Una sola GPU de **24 GB** funciona solo para prompts más ligeros con mayor latencia. Usa la **variante de modelo más grande / de tamaño completo que puedas ejecutar**; los checkpoints agresivamente cuantizados o "pequeños" aumentan el riesgo de inyección de prompts (ver [Seguridad](/es-ES/gateway/security)).

## Recomendado: LM Studio + MiniMax M2.1 (Responses API, tamaño completo)

El mejor stack local actual. Carga MiniMax M2.1 en LM Studio, habilita el servidor local (predeterminado `http://127.0.0.1:1234`), y usa Responses API para mantener el razonamiento separado del texto final.

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

- Instala LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- En LM Studio, descarga la **versión más grande disponible de MiniMax M2.1** (evita variantes "pequeñas" o altamente cuantizadas), inicia el servidor, confirma que `http://127.0.0.1:1234/v1/models` la lista.
- Mantén el modelo cargado; la carga en frío añade latencia de inicio.
- Ajusta `contextWindow`/`maxTokens` si tu versión de LM Studio difiere.
- Para WhatsApp, usa Responses API para que solo se envíe el texto final.

Mantén los modelos alojados configurados incluso cuando ejecutes localmente; usa `models.mode: "merge"` para que los respaldos permanezcan disponibles.

### Configuración híbrida: primario alojado, respaldo local

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

### Local primero con red de seguridad alojada

Intercambia el orden primario y de respaldo; mantén el mismo bloque de proveedores y `models.mode: "merge"` para poder recurrir a Sonnet u Opus cuando el equipo local esté inactivo.

### Alojamiento regional / enrutamiento de datos

- Las variantes alojadas de MiniMax/Kimi/GLM también existen en OpenRouter con endpoints fijados por región (ej., alojado en EE.UU.). Elige la variante regional allí para mantener el tráfico en tu jurisdicción elegida mientras usas `models.mode: "merge"` para respaldos de Anthropic/OpenAI.
- Solo local sigue siendo la ruta de privacidad más sólida; el enrutamiento regional alojado es el punto medio cuando necesitas características del proveedor pero quieres controlar el flujo de datos.

## Otros proxies locales compatibles con OpenAI

vLLM, LiteLLM, OAI-proxy o gateways personalizados funcionan si exponen un endpoint estilo OpenAI `/v1`. Reemplaza el bloque del proveedor anterior con tu endpoint e ID de modelo:

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

Mantén `models.mode: "merge"` para que los modelos alojados permanezcan disponibles como respaldos.

## Solución de problemas

- ¿El Gateway puede alcanzar el proxy? `curl http://127.0.0.1:1234/v1/models`.
- ¿Modelo de LM Studio descargado? Recarga; el inicio en frío es una causa común de "cuelgue".
- ¿Errores de contexto? Reduce `contextWindow` o aumenta el límite de tu servidor.
- Seguridad: los modelos locales omiten los filtros del lado del proveedor; mantén a los agentes restringidos y la compactación activada para limitar el radio de explosión de inyección de prompts.
