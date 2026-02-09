---
summary: "Use Z.AI (modelos GLM) con OpenClaw"
read_when:
  - Desea modelos Z.AI / GLM en OpenClaw
  - Necesita una configuración simple de ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI es la plataforma de API para los modelos **GLM**. Proporciona API REST para GLM y utiliza claves de API
para la autenticación. Cree su clave de API en la consola de Z.AI. OpenClaw utiliza el proveedor `zai`
con una clave de API de Z.AI.

## Configuración de la CLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Fragmento de configuración

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notas

- Los modelos GLM están disponibles como `zai/<model>` (ejemplo: `zai/glm-4.7`).
- Consulte [/providers/glm](/providers/glm) para obtener una visión general de la familia de modelos.
- Z.AI utiliza autenticación Bearer con su clave de API.
