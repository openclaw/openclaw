---
summary: "Twórz narzędzia agenta we wtyczce (schematy, narzędzia opcjonalne, listy dozwolonych)"
read_when:
  - Chcesz dodać nowe narzędzie agenta we wtyczce
  - Musisz uczynić narzędzie opcjonalnym (opt‑in) za pomocą list dozwolonych
title: "Narzędzia agenta we wtyczkach"
---

# Narzędzia agenta we wtyczkach

Wtyczki OpenClaw mogą rejestrować **narzędzia agenta** (funkcje w schemacie JSON), które są udostępniane
LLM podczas uruchomień agenta. Narzędzia mogą być **wymagane** (zawsze dostępne) lub
**opcjonalne** (opt‑in).

Narzędzia agenta są konfigurowane w głównej konfiguracji pod `tools` lub per‑agent pod
`agents.list[].tools`. Polityka listy dozwolonych/listy zabronionych kontroluje, które narzędzia agent
może wywoływać.

## Podstawowe narzędzie

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

## Narzędzie opcjonalne (opt‑in)

Narzędzia opcjonalne **nigdy** nie są włączane automatycznie. Użytkownicy muszą dodać je do
listy dozwolonych agenta.

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

Włącz narzędzia opcjonalne w `agents.list[].tools.allow` (lub globalnie w `tools.allow`):

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

Inne elementy konfiguracji wpływające na dostępność narzędzi:

- Listy dozwolonych, które wymieniają wyłącznie narzędzia wtyczek, są traktowane jako opt‑in wtyczek; narzędzia rdzeniowe pozostają
  włączone, chyba że uwzględnisz także narzędzia rdzeniowe lub grupy w liście dozwolonych.
- `tools.profile` / `agents.list[].tools.profile` (bazowa lista dozwolonych)
- `tools.byProvider` / `agents.list[].tools.byProvider` (specyficzne dla dostawcy zezwolenia/zakazy)
- `tools.sandbox.tools.*` (polityka narzędzi sandbox, gdy uruchomione w sandbox)

## Zasady + wskazówki

- Nazwy narzędzi **nie mogą** kolidować z nazwami narzędzi rdzeniowych; narzędzia kolidujące są pomijane.
- Identyfikatory wtyczek używane w listach dozwolonych nie mogą kolidować z nazwami narzędzi rdzeniowych.
- Preferuj `optional: true` dla narzędzi, które wywołują efekty uboczne lub wymagają dodatkowych
  binariów/poświadczeń.
