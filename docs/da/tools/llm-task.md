---
summary: "LLM-opgaver kun med JSON til workflows (valgfrit plugin-værktøj)"
read_when:
  - Du vil have et LLM-trin kun med JSON inde i workflows
  - Du har brug for skemavalideret LLM-output til automatisering
title: "LLM-opgave"
---

# LLM-opgave

`llm-task` er et **valgfrit plugin-værktøj**, der kører en LLM-opgave kun med JSON og
returnerer struktureret output (valgfrit valideret mod JSON Schema).

Dette er ideelt til workflow-motorer som Lobster: du kan tilføje et enkelt LLM-trin
uden at skrive brugerdefineret OpenClaw-kode for hvert workflow.

## Aktivér pluginet

1. Aktivér pluginet:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Tilføj værktøjet til tilladelseslisten (det er registreret med `optional: true`):

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

## Konfiguration (valgfrit)

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

`allowedModels` er en tilladt liste over `provider/model` strenge. Hvis angivet, en anmodning
uden for listen afvises.

## Værktøjsparametre

- `prompt` (string, påkrævet)
- `input` (any, valgfri)
- `schema` (object, valgfri JSON Schema)
- `provider` (string, valgfri)
- `model` (string, valgfri)
- `authProfileId` (string, valgfri)
- `temperature` (number, valgfri)
- `maxTokens` (number, valgfri)
- `timeoutMs` (number, valgfri)

## Output

Returnerer `details.json`, som indeholder den parsede JSON (og validerer mod
`schema`, når den er angivet).

## Eksempel: Lobster-workflowtrin

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

## Sikkerhedsnoter

- Værktøjet er **kun JSON** og instruerer modellen i kun at outputte JSON (ingen
  code fences, ingen kommentarer).
- Ingen værktøjer eksponeres for modellen i denne kørsel.
- Behandl output som utroværdigt, medmindre du validerer med `schema`.
- Placer godkendelser før ethvert trin med bivirkninger (send, post, exec).
