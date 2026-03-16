---
summary: "Écrire des outils d'agent dans un plugin (schémas, outils optionnels, listes blanches)"
read_when:
  - Vous voulez ajouter un nouvel outil d'agent dans un plugin
  - Vous devez rendre un outil opt-in via des listes blanches
title: "Outils d'agent de plugin"
---

# Outils d'agent de plugin

Les plugins OpenClaw peuvent enregistrer des **outils d'agent** (fonctions avec schéma JSON) qui sont exposés
au LLM pendant les exécutions d'agent. Les outils peuvent être **requis** (toujours disponibles) ou
**optionnels** (opt-in).

Les outils d'agent sont configurés sous `tools` dans la config principale, ou par agent sous
`agents.list[].tools`. La politique de liste blanche/noire contrôle quels outils l'agent
peut appeler.

## Outil basique

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Faire quelque chose",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## Outil optionnel (opt-in)

Les outils optionnels ne sont **jamais** auto-activés. Les utilisateurs doivent les ajouter à une
liste blanche d'agent.

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Exécuter un workflow local",
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

Activez les outils optionnels dans `agents.list[].tools.allow` (ou `tools.allow` global) :

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // nom d'outil spécifique
            "workflow", // id de plugin (active tous les outils de ce plugin)
            "group:plugins", // tous les outils de plugins
          ],
        },
      },
    ],
  },
}
```

Autres boutons de config qui affectent la disponibilité des outils :

- Les listes blanches qui nomment uniquement des outils de plugin sont traitées comme des opt-ins de plugin ; les outils principaux restent
  activés sauf si vous incluez aussi des outils principaux ou des groupes dans la liste blanche.
- `tools.profile` / `agents.list[].tools.profile` (liste blanche de base)
- `tools.byProvider` / `agents.list[].tools.byProvider` (allow/deny spécifique au fournisseur)
- `tools.sandbox.tools.*` (politique d'outil sandbox quand en sandbox)

## Règles + astuces

- Les noms d'outils ne doivent **pas** entrer en conflit avec les noms d'outils principaux ; les outils en conflit sont sautés.
- Les ids de plugin utilisés dans les listes blanches ne doivent pas entrer en conflit avec les noms d'outils principaux.
- Préférez `optional: true` pour les outils qui déclenchent des effets secondaires ou nécessitent des
  binaires/identifiants supplémentaires.
