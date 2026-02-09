---
summary: "Tâches LLM uniquement JSON pour les workflows (outil de plugin optionnel)"
read_when:
  - Vous souhaitez une étape LLM uniquement JSON dans les workflows
  - Vous avez besoin d’une sortie LLM validée par schéma pour l’automatisation
title: "Tâche LLM"
---

# Tâche LLM

`llm-task` est un **outil de plugin optionnel** qui exécute une tâche LLM uniquement JSON et
renvoie une sortie structurée (optionnellement validée par un schéma JSON).

C’est idéal pour les moteurs de workflow comme Lobster : vous pouvez ajouter une seule étape LLM
sans écrire de code OpenClaw personnalisé pour chaque workflow.

## Activer le plugin

1. Activez le plugin :

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Ajoutez l’outil à la liste d’autorisation (il est enregistré avec `optional: true`) :

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## Configuration (optionnelle)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` est une liste d’autorisation de chaînes `provider/model`. Si elle est définie, toute requête
en dehors de la liste est rejetée.

## Paramètres de l'outil

- `prompt` (string, requis)
- `input` (any, optionnel)
- `schema` (object, schéma JSON optionnel)
- `provider` (string, optionnel)
- `model` (string, optionnel)
- `authProfileId` (string, optionnel)
- `temperature` (number, optionnel)
- `maxTokens` (number, optionnel)
- `timeoutMs` (number, optionnel)

## Sortie

Renvoie `details.json` contenant le JSON analysé (et valide par rapport à
`schema` lorsqu’il est fourni).

## Exemple : étape de workflow Lobster

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## Notes de sécurité

- L’outil est **uniquement JSON** et demande au modèle de produire uniquement du JSON (pas de
  blocs de code, pas de commentaires).
- Aucun outil n’est exposé au modèle pour cette exécution.
- Traitez la sortie comme non fiable à moins de la valider avec `schema`.
- Placez des approbations avant toute étape ayant des effets de bord (envoyer, publier, exécuter).
