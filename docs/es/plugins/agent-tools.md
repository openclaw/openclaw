---
summary: "Escriba herramientas de agente en un plugin (esquemas, herramientas opcionales, listas de permitidos)"
read_when:
  - Quiere agregar una nueva herramienta de agente en un plugin
  - Necesita hacer que una herramienta sea de adhesión voluntaria mediante listas de permitidos
title: "Herramientas de agente del plugin"
---

# Herramientas de agente del plugin

Los plugins de OpenClaw pueden registrar **herramientas de agente** (funciones con esquema JSON) que se exponen al LLM durante las ejecuciones del agente. Las herramientas pueden ser **requeridas** (siempre disponibles) u **opcionales** (adhesión voluntaria).

Las herramientas de agente se configuran en `tools` en la configuración principal, o por agente en `agents.list[].tools`. La política de lista de permitidos/lista de denegados controla qué herramientas puede llamar el agente.

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

## Herramienta opcional (adhesión voluntaria)

Las herramientas opcionales **nunca** se habilitan automáticamente. Los usuarios deben agregarlas a la lista de permitidos de un agente.

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

Habilite herramientas opcionales en `agents.list[].tools.allow` (o globalmente en `tools.allow`):

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

Otros ajustes de configuración que afectan la disponibilidad de herramientas:

- Las listas de permitidos que solo nombran herramientas de plugins se tratan como adhesiones voluntarias de plugins; las herramientas del núcleo permanecen habilitadas a menos que también incluya herramientas o grupos del núcleo en la lista de permitidos.
- `tools.profile` / `agents.list[].tools.profile` (lista de permitidos base)
- `tools.byProvider` / `agents.list[].tools.byProvider` (permitir/denegar específico del proveedor)
- `tools.sandbox.tools.*` (política de herramientas del sandbox cuando está en sandbox)

## Reglas + consejos

- Los nombres de las herramientas **no** deben entrar en conflicto con los nombres de las herramientas del núcleo; las herramientas en conflicto se omiten.
- Los ids de plugins usados en listas de permitidos no deben entrar en conflicto con los nombres de las herramientas del núcleo.
- Prefiera `optional: true` para herramientas que desencadenan efectos secundarios o requieren binarios/credenciales adicionales.
