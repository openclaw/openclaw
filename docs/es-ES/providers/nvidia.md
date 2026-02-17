---
summary: "Usa la API compatible con OpenAI de NVIDIA en OpenClaw"
read_when:
  - Quieres usar modelos de NVIDIA en OpenClaw
  - Necesitas configuración de NVIDIA_API_KEY
title: "NVIDIA"
---

# NVIDIA

NVIDIA proporciona una API compatible con OpenAI en `https://integrate.api.nvidia.com/v1` para modelos Nemotron y NeMo. Autentica con una clave API de [NVIDIA NGC](https://catalog.ngc.nvidia.com/).

## Configuración CLI

Exporta la clave una vez, luego ejecuta la incorporación y establece un modelo de NVIDIA:

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/nvidia/llama-3.1-nemotron-70b-instruct
```

Si aún pasas `--token`, recuerda que termina en el historial del shell y salida de `ps`; prefiere la variable de entorno cuando sea posible.

## Fragmento de configuración

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## IDs de modelo

- `nvidia/llama-3.1-nemotron-70b-instruct` (predeterminado)
- `meta/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## Notas

- Endpoint `/v1` compatible con OpenAI; usa una clave API de NVIDIA NGC.
- El proveedor se auto-habilita cuando `NVIDIA_API_KEY` está configurado; usa valores predeterminados estáticos (ventana de contexto de 131,072 tokens, 4,096 tokens máximos).
