---
summary: "Ecrire des outils d’agent dans un plugin (schemas, outils optionnels, listes d’autorisation)"
read_when:
  - Vous souhaitez ajouter un nouvel outil d’agent dans un plugin
  - Vous devez rendre un outil optionnel via des listes d’autorisation
title: "Outils d’agent de plugin"
---

# Outils d’agent de plugin

Les plugins OpenClaw peuvent enregistrer des **outils d’agent** (fonctions JSON‑schema) exposés
au LLM pendant les executions d’agents. Les outils peuvent etre **requis** (toujours disponibles) ou
**optionnels** (activation explicite).

Les outils d’agent sont configures sous `tools` dans la configuration principale, ou par agent sous
`agents.list[].tools`. La politique de liste d’autorisation/liste de refus controle quels outils l’agent
peut appeler.

## Outil de base

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

## Outil optionnel (activation explicite)

Les outils optionnels ne sont **jamais** actives automatiquement. Les utilisateurs doivent les ajouter a une liste d’autorisation
d’agent.

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

Activez les outils optionnels dans `agents.list[].tools.allow` (ou globalement `tools.allow`) :

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

Autres parametres de configuration qui affectent la disponibilite des outils :

- Les listes d’autorisation qui ne nomment que des outils de plugin sont traitees comme des activations de plugin ; les outils du noyau restent
  actives sauf si vous incluez egalement des outils du noyau ou des groupes dans la liste d’autorisation.
- `tools.profile` / `agents.list[].tools.profile` (liste d’autorisation de base)
- `tools.byProvider` / `agents.list[].tools.byProvider` (autorisation/refus specifiques au fournisseur)
- `tools.sandbox.tools.*` (politique des outils de sandbox lorsqu’ils sont en sandbox)

## Regles + conseils

- Les noms d’outils ne doivent **pas** entrer en conflit avec les noms d’outils du noyau ; les outils conflictuels sont ignores.
- Les identifiants de plugin utilises dans les listes d’autorisation ne doivent pas entrer en conflit avec les noms d’outils du noyau.
- Preferez `optional: true` pour les outils qui declenchent des effets de bord ou necessitent des binaires/identifiants supplementaires.
