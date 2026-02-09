---
summary: "Sumulat ng mga agent tool sa isang plugin (schemas, mga opsyonal na tool, mga allowlist)"
read_when:
  - Gusto mong magdagdag ng bagong agent tool sa isang plugin
  - Kailangan mong gawing opt-in ang isang tool gamit ang mga allowlist
title: "Mga Plugin Agent Tool"
---

# Mga plugin agent tool

Maaaring magrehistro ang mga OpenClaw plugin ng **agent tools** (JSON‑schema functions) na inilalantad sa LLM sa panahon ng mga agent run. Ang mga tool ay maaaring **required** (laging available) o **optional** (opt‑in).

Ang mga agent tool ay kino-configure sa ilalim ng `tools` sa pangunahing config, o kada‑agent sa `agents.list[].tools`. Kinokontrol ng allowlist/denylist policy kung aling mga tool ang maaaring tawagin ng agent.

## Pangunahing tool

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

## Opsyonal na tool (opt‑in)

Optional tools are **never** auto‑enabled. Dapat idagdag ng mga user ang mga ito sa agent allowlist.

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

I-enable ang mga opsyonal na tool sa `agents.list[].tools.allow` (o global na `tools.allow`):

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

Iba pang mga config knob na nakaaapekto sa availability ng tool:

- Ang mga allowlist na tumutukoy lamang sa mga plugin tool ay tinatratong plugin opt-ins; mananatiling naka-enable ang mga core tool maliban kung isasama mo rin ang mga core tool o grupo sa allowlist.
- `tools.profile` / `agents.list[].tools.profile` (base allowlist)
- `tools.byProvider` / `agents.list[].tools.byProvider` (provider‑specific allow/deny)
- `tools.sandbox.tools.*` (patakaran ng sandbox tool kapag naka-sandbox)

## Mga tuntunin + tip

- Ang mga pangalan ng tool ay **hindi** dapat bumangga sa mga pangalan ng core tool; ang mga nagkakasalungat na tool ay nilalaktawan.
- Ang mga plugin id na ginagamit sa mga allowlist ay hindi dapat bumangga sa mga pangalan ng core tool.
- Mas mainam ang `optional: true` para sa mga tool na nagti-trigger ng side effects o nangangailangan ng karagdagang binaries/credentials.
