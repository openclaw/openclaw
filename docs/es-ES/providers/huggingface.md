---
summary: "Configuración de Hugging Face Inference (autenticación + selección de modelo)"
read_when:
  - Quieres usar Hugging Face Inference con OpenClaw
  - Necesitas la variable de entorno del token HF o elección de autenticación CLI
title: "Hugging Face (Inference)"
---

# Hugging Face (Inference)

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) ofrece completaciones de chat compatibles con OpenAI a través de una única API de enrutador. Obtienes acceso a muchos modelos (DeepSeek, Llama y más) con un solo token. OpenClaw usa el **endpoint compatible con OpenAI** (solo completaciones de chat); para texto a imagen, embeddings o voz usa los [clientes de inferencia de HF](https://huggingface.co/docs/api-inference/quicktour) directamente.

- Proveedor: `huggingface`
- Autenticación: `HUGGINGFACE_HUB_TOKEN` o `HF_TOKEN` (token de grano fino con **Hacer llamadas a Inference Providers**)
- API: Compatible con OpenAI (`https://router.huggingface.co/v1`)
- Facturación: Token único de HF; [precios](https://huggingface.co/docs/inference-providers/pricing) sigue las tarifas del proveedor con un nivel gratuito.

## Inicio rápido

1. Crea un token de grano fino en [Hugging Face → Settings → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) con el permiso **Make calls to Inference Providers**.
2. Ejecuta la incorporación y elige **Hugging Face** en el menú desplegable de proveedores, luego ingresa tu clave API cuando se te solicite:

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. En el menú desplegable **Default Hugging Face model**, selecciona el modelo que deseas (la lista se carga desde la API de Inference cuando tienes un token válido; de lo contrario se muestra una lista incorporada). Tu elección se guarda como el modelo predeterminado.
4. También puedes establecer o cambiar el modelo predeterminado más tarde en la configuración:

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## Ejemplo no interactivo

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

Esto establecerá `huggingface/deepseek-ai/DeepSeek-R1` como el modelo predeterminado.

## Nota sobre el entorno

Si el Gateway se ejecuta como daemon (launchd/systemd), asegúrate de que `HUGGINGFACE_HUB_TOKEN` o `HF_TOKEN`
esté disponible para ese proceso (por ejemplo, en `~/.openclaw/.env` o vía
`env.shellEnv`).

## Descubrimiento de modelos y menú desplegable de incorporación

OpenClaw descubre modelos llamando directamente al **endpoint de Inference**:

```bash
GET https://router.huggingface.co/v1/models
```

(Opcional: envía `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` o `$HF_TOKEN` para la lista completa; algunos endpoints devuelven un subconjunto sin autenticación.) La respuesta es estilo OpenAI `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`.

Cuando configuras una clave API de Hugging Face (vía incorporación, `HUGGINGFACE_HUB_TOKEN`, o `HF_TOKEN`), OpenClaw usa este GET para descubrir modelos de completación de chat disponibles. Durante la **incorporación interactiva**, después de ingresar tu token ves un menú desplegable **Default Hugging Face model** poblado desde esa lista (o el catálogo incorporado si la solicitud falla). En tiempo de ejecución (ej. inicio del Gateway), cuando hay una clave presente, OpenClaw llama nuevamente a **GET** `https://router.huggingface.co/v1/models` para actualizar el catálogo. La lista se fusiona con un catálogo incorporado (para metadatos como ventana de contexto y costo). Si la solicitud falla o no hay clave configurada, solo se usa el catálogo incorporado.

## Nombres de modelos y opciones editables

- **Nombre desde la API:** El nombre de visualización del modelo se **hidrata desde GET /v1/models** cuando la API devuelve `name`, `title`, o `display_name`; de lo contrario se deriva del id del modelo (ej. `deepseek-ai/DeepSeek-R1` → "DeepSeek R1").
- **Sobrescribir nombre de visualización:** Puedes establecer una etiqueta personalizada por modelo en la configuración para que aparezca como deseas en la CLI y UI:

```json5
{
  agents: {
    defaults: {
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (rápido)" },
        "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (económico)" },
      },
    },
  },
}
```

- **Selección de proveedor / política:** Agrega un sufijo al **id del modelo** para elegir cómo el enrutador selecciona el backend:
  - **`:fastest`** — mayor rendimiento (el enrutador elige; la elección del proveedor está **bloqueada** — no hay selector de backend interactivo).
  - **`:cheapest`** — menor costo por token de salida (el enrutador elige; la elección del proveedor está **bloqueada**).
  - **`:provider`** — fuerza un backend específico (ej. `:sambanova`, `:together`).

  Cuando seleccionas **:cheapest** o **:fastest** (ej. en el menú desplegable de modelo de incorporación), el proveedor está bloqueado: el enrutador decide por costo o velocidad y no se muestra un paso opcional de "preferir backend específico". Puedes agregar estos como entradas separadas en `models.providers.huggingface.models` o establecer `model.primary` con el sufijo. También puedes establecer tu orden predeterminado en [Inference Provider settings](https://hf.co/settings/inference-providers) (sin sufijo = usar ese orden).

- **Fusión de configuración:** Las entradas existentes en `models.providers.huggingface.models` (ej. en `models.json`) se mantienen cuando se fusiona la configuración. Así que cualquier `name`, `alias`, u opciones de modelo personalizadas que establezcas allí se preservan.

## IDs de modelo y ejemplos de configuración

Las referencias de modelo usan la forma `huggingface/<org>/<model>` (IDs estilo Hub). La lista a continuación es de **GET** `https://router.huggingface.co/v1/models`; tu catálogo puede incluir más.

**IDs de ejemplo (desde el endpoint de inferencia):**

| Modelo                 | Referencia (prefijo con `huggingface/`) |
| ---------------------- | ----------------------------------- |
| DeepSeek R1            | `deepseek-ai/DeepSeek-R1`           |
| DeepSeek V3.2          | `deepseek-ai/DeepSeek-V3.2`         |
| Qwen3 8B               | `Qwen/Qwen3-8B`                     |
| Qwen2.5 7B Instruct    | `Qwen/Qwen2.5-7B-Instruct`          |
| Qwen3 32B              | `Qwen/Qwen3-32B`                    |
| Llama 3.3 70B Instruct | `meta-llama/Llama-3.3-70B-Instruct` |
| Llama 3.1 8B Instruct  | `meta-llama/Llama-3.1-8B-Instruct`  |
| GPT-OSS 120B           | `openai/gpt-oss-120b`               |
| GLM 4.7                | `zai-org/GLM-4.7`                   |
| Kimi K2.5              | `moonshotai/Kimi-K2.5`              |

Puedes agregar `:fastest`, `:cheapest`, o `:provider` (ej. `:together`, `:sambanova`) al id del modelo. Establece tu orden predeterminado en [Inference Provider settings](https://hf.co/settings/inference-providers); consulta [Inference Providers](https://huggingface.co/docs/inference-providers) y **GET** `https://router.huggingface.co/v1/models` para la lista completa.

### Ejemplos de configuración completa

**DeepSeek R1 primario con respaldo Qwen:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-R1",
        fallbacks: ["huggingface/Qwen/Qwen3-8B"],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
      },
    },
  },
}
```

**Qwen como predeterminado, con variantes :cheapest y :fastest:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3-8B" },
      models: {
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
        "huggingface/Qwen/Qwen3-8B:cheapest": { alias: "Qwen3 8B (más económico)" },
        "huggingface/Qwen/Qwen3-8B:fastest": { alias: "Qwen3 8B (más rápido)" },
      },
    },
  },
}
```

**DeepSeek + Llama + GPT-OSS con alias:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-V3.2",
        fallbacks: [
          "huggingface/meta-llama/Llama-3.3-70B-Instruct",
          "huggingface/openai/gpt-oss-120b",
        ],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-V3.2": { alias: "DeepSeek V3.2" },
        "huggingface/meta-llama/Llama-3.3-70B-Instruct": { alias: "Llama 3.3 70B" },
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
      },
    },
  },
}
```

**Forzar un backend específico con :provider:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1:together" },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1:together": { alias: "DeepSeek R1 (Together)" },
      },
    },
  },
}
```

**Múltiples modelos Qwen y DeepSeek con sufijos de política:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest" },
      models: {
        "huggingface/Qwen/Qwen2.5-7B-Instruct": { alias: "Qwen2.5 7B" },
        "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest": { alias: "Qwen2.5 7B (económico)" },
        "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1 (rápido)" },
        "huggingface/meta-llama/Llama-3.1-8B-Instruct": { alias: "Llama 3.1 8B" },
      },
    },
  },
}
```
