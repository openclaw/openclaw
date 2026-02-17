---
summary: "Escribe herramientas de agente en un plugin (esquemas, herramientas opcionales, listas permitidas)"
read_when:
  - Quieres agregar una nueva herramienta de agente en un plugin
  - Necesitas hacer que una herramienta sea opcional mediante listas permitidas
title: "Herramientas de Agente en Plugins"
---

# Herramientas de agente en plugins

Los plugins de OpenClaw pueden registrar **herramientas de agente** (funciones con esquema JSON) que se exponen
al LLM durante las ejecuciones del agente. Las herramientas pueden ser **requeridas** (siempre disponibles) u
**opcionales** (opt-in).

Las herramientas de agente se configuran bajo `tools` en la configuración principal, o por agente bajo
`agents.list[].tools`. La política de lista permitida/denegada controla qué herramientas puede
llamar el agente.

## Herramienta básica

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## Herramienta opcional (opt-in)

Las herramientas opcionales **nunca** se habilitan automáticamente. Los usuarios deben agregarlas a una lista
permitida del agente.

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

Habilita herramientas opcionales en `agents.list[].tools.allow` (o global `tools.allow`):

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // nombre específico de herramienta
            "workflow", // id del plugin (habilita todas las herramientas de ese plugin)
            "group:plugins", // todas las herramientas de plugins
          ],
        },
      },
    ],
  },
}
```

Otros controles de configuración que afectan la disponibilidad de herramientas:

- Las listas permitidas que solo nombran herramientas de plugins se tratan como opt-ins de plugins; las herramientas del núcleo permanecen
  habilitadas a menos que también incluyas herramientas del núcleo o grupos en la lista permitida.
- `tools.profile` / `agents.list[].tools.profile` (lista permitida base)
- `tools.byProvider` / `agents.list[].tools.byProvider` (permitir/denegar específico por proveedor)
- `tools.sandbox.tools.*` (política de herramientas del sandbox cuando está en sandbox)

## Reglas + consejos

- Los nombres de herramientas **no** deben entrar en conflicto con los nombres de herramientas del núcleo; las herramientas en conflicto se omiten.
- Los ids de plugins utilizados en listas permitidas no deben entrar en conflicto con nombres de herramientas del núcleo.
- Prefiere `optional: true` para herramientas que desencadenan efectos secundarios o requieren
  binarios/credenciales adicionales.
