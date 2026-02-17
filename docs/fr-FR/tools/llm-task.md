---
summary: "Tâches LLM JSON-only pour workflows (tool plugin optionnel)"
read_when:
  - Vous voulez step LLM JSON-only dans workflows
  - Vous avez besoin output LLM validé schéma pour automation
title: "Tâche LLM"
---

# Tâche LLM

`llm-task` est **tool plugin optionnel** qui exécute tâche LLM JSON-only et retourne output structuré (optionnellement validé contre JSON Schema).

Idéal pour moteurs workflow comme Lobster : vous pouvez ajouter step LLM unique sans écrire code OpenClaw custom pour chaque workflow.

## Activer plugin

1. Activer plugin :

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Allowlister tool (enregistré avec `optional: true`) :

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

## Config (optionnel)

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

`allowedModels` est allowlist strings `provider/model`. Si défini, n'importe quelle requête hors liste rejetée.

## Paramètres tool

- `prompt` (string, requis)
- `input` (any, optionnel)
- `schema` (object, optionnel JSON Schema)
- `provider` (string, optionnel)
- `model` (string, optionnel)
- `authProfileId` (string, optionnel)
- `temperature` (number, optionnel)
- `maxTokens` (number, optionnel)

## Utilisation

### Exemple basique

```json
{
  "tool": "llm-task",
  "prompt": "Extraire entités nommées depuis ce texte",
  "input": "OpenClaw est framework agent créé par Peter."
}
```

Réponse :

```json
{
  "entities": [
    { "name": "OpenClaw", "type": "product" },
    { "name": "Peter", "type": "person" }
  ]
}
```

### Avec validation schema

```json
{
  "tool": "llm-task",
  "prompt": "Analyser sentiment cette review produit",
  "input": "Ce produit est incroyable! Ça marche parfaitement.",
  "schema": {
    "type": "object",
    "properties": {
      "sentiment": { "type": "string", "enum": ["positive", "negative", "neutral"] },
      "score": { "type": "number", "minimum": 0, "maximum": 1 },
      "aspects": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["sentiment", "score"]
  }
}
```

### Model override

```json
{
  "tool": "llm-task",
  "prompt": "Résumer ce document",
  "input": "...",
  "provider": "anthropic",
  "model": "claude-sonnet-4.5",
  "temperature": 0.3,
  "maxTokens": 500
}
```

## Cas usage

### 1. Extraction données

Extraire informations structurées depuis texte unstructured :

```json
{
  "prompt": "Extraire date, lieu et participants depuis email invitation",
  "input": "Réunion jeudi 15h à Paris avec Jean et Marie"
}
```

### 2. Classification

Catégoriser contenu :

```json
{
  "prompt": "Classifier ticket support",
  "input": "Mon login marche pas",
  "schema": {
    "type": "object",
    "properties": {
      "category": { "enum": ["bug", "feature", "question"] },
      "priority": { "enum": ["low", "medium", "high"] }
    }
  }
}
```

### 3. Transformation

Convertir format données :

```json
{
  "prompt": "Convertir CSV vers JSON structuré",
  "input": "nom,age,ville\nAlice,30,Paris\nBob,25,Lyon"
}
```

### 4. Validation

Vérifier conformité données :

```json
{
  "prompt": "Valider format adresse postale française",
  "input": "123 rue Example, 75001 Paris"
}
```

## Intégration Lobster

Dans workflow Lobster :

```yaml
steps:
  - name: extract-entities
    tool: llm-task
    params:
      prompt: "Extraire personnes et organisations"
      input: "{{ steps.fetch-document.output }}"
      schema:
        type: object
        properties:
          people: { type: array }
          organizations: { type: array }

  - name: classify
    tool: llm-task
    params:
      prompt: "Classifier document type"
      input: "{{ steps.extract-entities.output }}"
```

## Sécurité

- **Model allowlist** : restreindre modèles autorisés via `allowedModels`
- **Timeout** : limiter durée exécution via `timeoutMs`
- **Token limit** : contrôler coût via `maxTokens`
- **Schema validation** : forcer format output structuré

## Dépannage

**Schema validation échoue :**

```bash
# Vérifier schema JSON Schema valide
openclaw plugin llm-task validate-schema <schema.json>
```

**Model pas autorisé :**

```bash
# Voir modèles autorisés
openclaw config get plugins.entries.llm-task.config.allowedModels

# Ajouter modèle à allowlist
openclaw config set plugins.entries.llm-task.config.allowedModels '["provider/model"]'
```

**Timeout :**

```bash
# Augmenter timeout
openclaw config set plugins.entries.llm-task.config.timeoutMs 60000
```

Voir aussi :

- [Lobster](/fr-FR/tools/lobster)
- [JSON Schema](https://json-schema.org/)
