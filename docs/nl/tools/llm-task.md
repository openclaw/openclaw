---
summary: "LLM-taken met alleen JSON voor workflows (optionele plugin-tool)"
read_when:
  - Je wilt een LLM-stap met alleen JSON binnen workflows
  - Je hebt schema-gevalideerde LLM-uitvoer nodig voor automatisering
title: "LLM-taak"
---

# LLM-taak

`llm-task` is een **optionele plugin-tool** die een LLM-taak met alleen JSON uitvoert en
gestructureerde uitvoer retourneert (optioneel gevalideerd tegen JSON Schema).

Dit is ideaal voor workflow-engines zoals Lobster: je kunt één enkele LLM-stap toevoegen
zonder voor elke workflow aangepaste OpenClaw-code te schrijven.

## De plugin inschakelen

1. Schakel de plugin in:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Zet de tool op de toegestane lijst (deze is geregistreerd met `optional: true`):

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

## Config (optioneel)

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

`allowedModels` is een toegestane lijst van `provider/model`-strings. Indien ingesteld,
wordt elk verzoek buiten de lijst geweigerd.

## Toolparameters

- `prompt` (string, vereist)
- `input` (any, optioneel)
- `schema` (object, optioneel JSON Schema)
- `provider` (string, optioneel)
- `model` (string, optioneel)
- `authProfileId` (string, optioneel)
- `temperature` (number, optioneel)
- `maxTokens` (number, optioneel)
- `timeoutMs` (number, optioneel)

## Uitvoer

Retourneert `details.json` met daarin de geparste JSON (en valideert tegen
`schema` wanneer opgegeven).

## Voorbeeld: Lobster-workflowstap

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

## Veiligheidsnotities

- De tool is **alleen JSON** en instrueert het model om uitsluitend JSON uit te voeren (geen
  codeblokken, geen commentaar).
- Er worden voor deze run geen tools aan het model blootgesteld.
- Behandel de uitvoer als niet-vertrouwd tenzij je valideert met `schema`.
- Plaats goedkeuringen vóór elke stap met bijwerkingen (verzenden, posten, uitvoeren).
