---
summary: "Ejecuta OpenClaw con vLLM (servidor local compatible con OpenAI)"
read_when:
  - Quieres ejecutar OpenClaw contra un servidor vLLM local
  - Quieres endpoints /v1 compatibles con OpenAI con tus propios modelos
title: "vLLM"
---

# vLLM

vLLM puede servir modelos de código abierto (y algunos personalizados) vía una API HTTP **compatible con OpenAI**. OpenClaw puede conectarse a vLLM usando la API `openai-completions`.

OpenClaw también puede **auto-descubrir** modelos disponibles desde vLLM cuando optas por ello con `VLLM_API_KEY` (cualquier valor funciona si tu servidor no aplica autenticación) y no defines una entrada explícita `models.providers.vllm`.

## Inicio rápido

1. Inicia vLLM con un servidor compatible con OpenAI.

Tu URL base debe exponer endpoints `/v1` (ej. `/v1/models`, `/v1/chat/completions`). vLLM comúnmente se ejecuta en:

- `http://127.0.0.1:8000/v1`

2. Opta por ello (cualquier valor funciona si no hay autenticación configurada):

```bash
export VLLM_API_KEY="vllm-local"
```

3. Selecciona un modelo (reemplaza con uno de tus IDs de modelo vLLM):

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## Descubrimiento de modelos (proveedor implícito)

Cuando `VLLM_API_KEY` está configurado (o existe un perfil de autenticación) y **no** defines `models.providers.vllm`, OpenClaw consultará:

- `GET http://127.0.0.1:8000/v1/models`

…y convertirá los IDs devueltos en entradas de modelo.

Si estableces `models.providers.vllm` explícitamente, el auto-descubrimiento se omite y debes definir los modelos manualmente.

## Configuración explícita (modelos manuales)

Usa configuración explícita cuando:

- vLLM se ejecuta en un host/puerto diferente.
- Quieres fijar valores de `contextWindow`/`maxTokens`.
- Tu servidor requiere una clave API real (o quieres controlar los headers).

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Solución de problemas

- Verifica que el servidor sea accesible:

```bash
curl http://127.0.0.1:8000/v1/models
```

- Si las solicitudes fallan con errores de autenticación, establece un `VLLM_API_KEY` real que coincida con la configuración de tu servidor, o configura el proveedor explícitamente bajo `models.providers.vllm`.
