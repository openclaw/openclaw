---
summary: "Skriv agentværktøjer i et plugin (skemaer, valgfrie værktøjer, tilladelseslister)"
read_when:
  - Du vil tilføje et nyt agentværktøj i et plugin
  - Du skal gøre et værktøj valgfrit via tilladelseslister
title: "Plugin-agentværktøjer"
x-i18n:
  source_path: plugins/agent-tools.md
  source_hash: 4479462e9d8b17b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:29Z
---

# Plugin-agentværktøjer

OpenClaw-plugins kan registrere **agentværktøjer** (JSON‑schema‑funktioner), som eksponeres
for LLM’en under agentkørsler. Værktøjer kan være **påkrævede** (altid tilgængelige) eller
**valgfrie** (opt‑in).

Agentværktøjer konfigureres under `tools` i hovedkonfigurationen eller pr. agent under
`agents.list[].tools`. Politikken for tilladelsesliste/afvisningsliste styrer, hvilke værktøjer agenten
kan kalde.

## Grundlæggende værktøj

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

## Valgfrit værktøj (opt‑in)

Valgfrie værktøjer bliver **aldrig** aktiveret automatisk. Brugere skal tilføje dem til en agents
tilladelsesliste.

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

Aktivér valgfrie værktøjer i `agents.list[].tools.allow` (eller globalt i `tools.allow`):

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

Andre konfigurationsindstillinger, der påvirker værktøjers tilgængelighed:

- Tilladelseslister, der kun navngiver plugin‑værktøjer, behandles som plugin‑opt‑ins; kerneværktøjer
  forbliver aktiveret, medmindre du også inkluderer kerneværktøjer eller grupper i tilladelseslisten.
- `tools.profile` / `agents.list[].tools.profile` (basis‑tilladelsesliste)
- `tools.byProvider` / `agents.list[].tools.byProvider` (udbyderspecifik tillad/afvis)
- `tools.sandbox.tools.*` (sandbox‑værktøjspolitik ved sandboxing)

## Regler + tips

- Værktøjsnavne må **ikke** kollidere med navne på kerneværktøjer; værktøjer med konflikter springes over.
- Plugin‑id’er, der bruges i tilladelseslister, må ikke kollidere med navne på kerneværktøjer.
- Foretræk `optional: true` for værktøjer, der udløser sideeffekter eller kræver ekstra
  binære filer/legitimationsoplysninger.
