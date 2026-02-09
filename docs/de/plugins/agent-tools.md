---
summary: "Agent-Werkzeuge in einem Plugin schreiben (Schemas, optionale Werkzeuge, Allowlists)"
read_when:
  - Sie möchten in einem Plugin ein neues Agent-Werkzeug hinzufügen
  - Sie müssen ein Werkzeug per Allowlist optional machen
title: "Plugin-Agent-Werkzeuge"
---

# Plugin-Agent-Werkzeuge

OpenClaw-Plugins können **Agent-Werkzeuge** (JSON‑Schema‑Funktionen) registrieren, die dem LLM während Agent-Läufen zur Verfügung gestellt werden. Werkzeuge können **erforderlich** (immer verfügbar) oder **optional** (Opt‑in) sein.

Agent-Werkzeuge werden im Hauptkonfigurationsbereich unter `tools` oder agentenweise unter `agents.list[].tools` konfiguriert. Die Allowlist-/Denylist-Richtlinie steuert, welche Werkzeuge der Agent aufrufen kann.

## Basis-Werkzeug

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

## Optionales Werkzeug (Opt‑in)

Optionale Werkzeuge werden **niemals** automatisch aktiviert. Nutzer müssen sie einer Agent-Allowlist hinzufügen.

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

Aktivieren Sie optionale Werkzeuge in `agents.list[].tools.allow` (oder global in `tools.allow`):

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

Weitere Konfigurationsoptionen, die die Verfügbarkeit von Werkzeugen beeinflussen:

- Allowlists, die ausschließlich Plugin-Werkzeuge nennen, werden als Plugin-Opt-ins behandelt; Kernwerkzeuge bleiben aktiviert, sofern Sie nicht auch Kernwerkzeuge oder -gruppen in der Allowlist aufnehmen.
- `tools.profile` / `agents.list[].tools.profile` (Basis-Allowlist)
- `tools.byProvider` / `agents.list[].tools.byProvider` (anbieter­spezifisches Zulassen/Verweigern)
- `tools.sandbox.tools.*` (Sandbox-Werkzeugrichtlinie bei Sandbox-Betrieb)

## Regeln + Tipps

- Werkzeugnamen dürfen **nicht** mit Namen von Kernwerkzeugen kollidieren; kollidierende Werkzeuge werden übersprungen.
- In Allowlists verwendete Plugin-IDs dürfen nicht mit Namen von Kernwerkzeugen kollidieren.
- Bevorzugen Sie `optional: true` für Werkzeuge, die Nebenwirkungen auslösen oder zusätzliche Binärdateien/Anmeldedaten erfordern.
