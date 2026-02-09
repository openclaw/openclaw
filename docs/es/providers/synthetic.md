---
summary: "Use la API compatible con Anthropic de Synthetic en OpenClaw"
read_when:
  - Quiere usar Synthetic como proveedor de modelos
  - Necesita una clave de API de Synthetic o configurar la URL base
title: "Synthetic"
---

# Synthetic

Synthetic expone endpoints compatibles con Anthropic. OpenClaw lo registra como el
proveedor `synthetic` y utiliza la API de Mensajes de Anthropic.

## Configuración rápida

1. Establezca `SYNTHETIC_API_KEY` (o ejecute el asistente a continuación).
2. Ejecute el onboarding:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

El modelo predeterminado se establece en:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Ejemplo de configuración

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Nota: el cliente de Anthropic de OpenClaw agrega `/v1` a la URL base, por lo que use
`https://api.synthetic.new/anthropic` (no `/anthropic/v1`). Si Synthetic cambia
su URL base, sobrescriba `models.providers.synthetic.baseUrl`.

## Catálogo de modelos

Todos los modelos a continuación usan el costo `0` (entrada/salida/caché).

| ID del modelo                                          | Ventana de contexto | Tokens máx. | Razonamiento | Entrada      |
| ------------------------------------------------------ | ------------------- | --------------------------- | ------------ | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000              | 65536                       | false        | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000              | 8192                        | true         | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000              | 128000                      | false        | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000              | 8192                        | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000              | 8192                        | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000              | 8192                        | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000              | 8192                        | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000              | 8192                        | false        | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000              | 8192                        | false        | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000              | 8192                        | false        | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000              | 8192                        | false        | text         |
| `hf:openai/gpt-oss-120b`                               | 128000              | 8192                        | false        | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000              | 8192                        | false        | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000              | 8192                        | false        | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000              | 8192                        | false        | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000              | 128000                      | false        | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000              | 128000                      | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000              | 8192                        | false        | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000              | 8192                        | true         | text         |

## Notas

- Las referencias de modelos usan `synthetic/<modelId>`.
- Si habilita una lista de permitidos de modelos (`agents.defaults.models`), agregue todos los modelos que
  planea usar.
- Consulte [Proveedores de modelos](/concepts/model-providers) para conocer las reglas de los proveedores.
