---
summary: "Ejecuta OpenClaw mediante LiteLLM Proxy para acceso unificado a modelos y seguimiento de costos"
read_when:
  - Quieres enrutar OpenClaw mediante un proxy de LiteLLM
  - Necesitas seguimiento de costos, registro o enrutamiento de modelos mediante LiteLLM
---

# LiteLLM

[LiteLLM](https://litellm.ai) es un gateway de LLM de código abierto que proporciona una API unificada para más de 100 proveedores de modelos. Enruta OpenClaw mediante LiteLLM para obtener seguimiento centralizado de costos, registro y la flexibilidad de cambiar backends sin modificar tu configuración de OpenClaw.

## ¿Por qué usar LiteLLM con OpenClaw?

- **Seguimiento de costos** — Ve exactamente cuánto gasta OpenClaw en todos los modelos
- **Enrutamiento de modelos** — Cambia entre Claude, GPT-4, Gemini, Bedrock sin cambios de configuración
- **Claves virtuales** — Crea claves con límites de gasto para OpenClaw
- **Registro** — Registros completos de solicitud/respuesta para depuración
- **Respaldos** — Conmutación automática si tu proveedor principal está caído

## Inicio rápido

### Mediante incorporación

```bash
openclaw onboard --auth-choice litellm-api-key
```

### Configuración manual

1. Inicia LiteLLM Proxy:

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. Apunta OpenClaw a LiteLLM:

```bash
export LITELLM_API_KEY="your-litellm-key"

openclaw
```

Eso es todo. OpenClaw ahora se enruta mediante LiteLLM.

## Configuración

### Variables de entorno

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### Archivo de configuración

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-opus-4-6" },
    },
  },
}
```

## Claves virtuales

Crea una clave dedicada para OpenClaw con límites de gasto:

```bash
curl -X POST "http://localhost:4000/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "openclaw",
    "max_budget": 50.00,
    "budget_duration": "monthly"
  }'
```

Usa la clave generada como `LITELLM_API_KEY`.

## Enrutamiento de modelos

LiteLLM puede enrutar solicitudes de modelo a diferentes backends. Configura en tu `config.yaml` de LiteLLM:

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: gpt-4o
    litellm_params:
      model: gpt-4o
      api_key: os.environ/OPENAI_API_KEY
```

OpenClaw sigue solicitando `claude-opus-4-6` — LiteLLM maneja el enrutamiento.

## Ver uso

Consulta el panel de LiteLLM o API:

```bash
# Información de clave
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# Registros de gasto
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## Notas

- LiteLLM se ejecuta en `http://localhost:4000` por defecto
- OpenClaw se conecta mediante el endpoint compatible con OpenAI `/v1/chat/completions`
- Todas las características de OpenClaw funcionan mediante LiteLLM — sin limitaciones

## Ver también

- [Documentación de LiteLLM](https://docs.litellm.ai)
- [Proveedores de modelos](/es-ES/concepts/model-providers)
