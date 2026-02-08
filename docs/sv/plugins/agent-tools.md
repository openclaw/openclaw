---
summary: "Skriv agentverktyg i ett plugin (scheman, valfria verktyg, tillåtelselistor)"
read_when:
  - Du vill lägga till ett nytt agentverktyg i ett plugin
  - Du behöver göra ett verktyg valfritt via tillåtelselistor
title: "Plugin-agentverktyg"
x-i18n:
  source_path: plugins/agent-tools.md
  source_hash: 4479462e9d8b17b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:04Z
---

# Plugin-agentverktyg

OpenClaw‑pluginer kan registrera **agentverktyg** (JSON‑schemafunktioner) som exponeras
för LLM:en under agentkörningar. Verktyg kan vara **obligatoriska** (alltid tillgängliga) eller
**valfria** (opt‑in).

Agentverktyg konfigureras under `tools` i huvudkonfigen, eller per agent under
`agents.list[].tools`. Policyn för tillåtelselista/nekandelista styr vilka verktyg agenten
kan anropa.

## Grundläggande verktyg

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

## Valfritt verktyg (opt‑in)

Valfria verktyg är **aldrig** automatiskt aktiverade. Användare måste lägga till dem i en agents
tillåtelselista.

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

Aktivera valfria verktyg i `agents.list[].tools.allow` (eller globalt i `tools.allow`):

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

Andra konfigurationsreglage som påverkar verktygstillgänglighet:

- Tillåtelselistor som endast namnger pluginverktyg behandlas som plugin‑opt‑ins; kärnverktyg förblir
  aktiverade om du inte också inkluderar kärnverktyg eller grupper i tillåtelselistan.
- `tools.profile` / `agents.list[].tools.profile` (bas‑tillåtelselista)
- `tools.byProvider` / `agents.list[].tools.byProvider` (leverantörsspecifik tillåt/nekande)
- `tools.sandbox.tools.*` (policy för sandbox‑verktyg när sandboxad)

## Regler + tips

- Verktygsnamn får **inte** krocka med kärnverktygsnamn; verktyg i konflikt hoppas över.
- Plugin‑ID:n som används i tillåtelselistor får inte krocka med kärnverktygsnamn.
- Föredra `optional: true` för verktyg som utlöser bieffekter eller kräver extra
  binärer/autentiseringsuppgifter.
