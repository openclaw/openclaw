---
summary: "Schrijf agent-tools in een plugin (schema’s, optionele tools, toegestane lijsten)"
read_when:
  - Je wilt een nieuwe agent-tool toevoegen in een plugin
  - Je moet een tool opt-in maken via toegestane lijsten
title: "Plugin Agent Tools"
---

# Plugin agent-tools

OpenClaw-plugins kunnen **agent-tools** (JSON-schemafuncties) registreren die
tijdens agent-runs aan de LLM worden blootgesteld. Tools kunnen **vereist**
(zijn altijd beschikbaar) of **optioneel** (opt-in) zijn.

Agent-tools worden geconfigureerd onder `tools` in de hoofdconfig, of per agent onder
`agents.list[].tools`. Het beleid voor toegestane lijsten/weigerlijsten bepaalt welke tools de agent
kan aanroepen.

## Basistool

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

## Optionele tool (opt-in)

Optionele tools worden **nooit** automatisch ingeschakeld. Gebruikers moeten ze toevoegen aan
een toegestane lijst van een agent.

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

Schakel optionele tools in via `agents.list[].tools.allow` (of globaal `tools.allow`):

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

Andere config-opties die de beschikbaarheid van tools beïnvloeden:

- Toegestane lijsten die alleen plugin-tools noemen, worden behandeld als plugin-opt-ins; kern-tools blijven
  ingeschakeld tenzij je ook kern-tools of -groepen in de toegestane lijst opneemt.
- `tools.profile` / `agents.list[].tools.profile` (basis-toegestane lijst)
- `tools.byProvider` / `agents.list[].tools.byProvider` (provider-specifiek toestaan/weigeren)
- `tools.sandbox.tools.*` (sandbox-toolbeleid wanneer gesandboxed)

## Regels + tips

- Toolnamen mogen **niet** botsen met namen van kern-tools; conflicterende tools worden overgeslagen.
- Plugin-id’s die in toegestane lijsten worden gebruikt, mogen niet botsen met namen van kern-tools.
- Geef de voorkeur aan `optional: true` voor tools die neveneffecten veroorzaken of extra
  binaries/referenties vereisen.
