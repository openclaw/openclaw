---
summary: "Descripción general de la familia de modelos GLM + cómo usarla en OpenClaw"
read_when:
  - Quiere modelos GLM en OpenClaw
  - Necesita la convención de nombres de modelos y la configuración
title: "Modelos GLM"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:14Z
---

# Modelos GLM

GLM es una **familia de modelos** (no una empresa) disponible a través de la plataforma Z.AI. En OpenClaw, los modelos GLM
se acceden mediante el proveedor `zai` y con IDs de modelo como `zai/glm-4.7`.

## Configuración de la CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## Fragmento de configuración

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notas

- Las versiones y la disponibilidad de GLM pueden cambiar; consulte la documentación de Z.AI para conocer lo más reciente.
- Ejemplos de IDs de modelo incluyen `glm-4.7` y `glm-4.6`.
- Para detalles del proveedor, consulte [/providers/zai](/providers/zai).
