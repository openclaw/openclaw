---
summary: "Endast JSON-baserade LLM-uppgifter för arbetsflöden (valfritt pluginverktyg)"
read_when:
  - Du vill ha ett LLM-steg som endast returnerar JSON i arbetsflöden
  - Du behöver schemavaliderad LLM-utdata för automatisering
title: "LLM Task"
---

# LLM Task

`llm-task` är ett **valfritt pluginverktyg** som kör en LLM-uppgift som endast returnerar JSON och
returnerar strukturerad utdata (valfritt validerad mot JSON Schema).

Detta är idealiskt för arbetsflödesmotorer som Lobster: du kan lägga till ett enda LLM-steg
utan att skriva anpassad OpenClaw-kod för varje arbetsflöde.

## Aktivera pluginet

1. Aktivera pluginet:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Lägg till verktyget i tillåtelselistan (det är registrerat med `optional: true`):

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

## Konfig (valfritt)

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

`allowedModels` är en tillåten lista med `provider/model`-strängar. Om angivet så avvisas en begäran
utanför listan.

## Verktygsparametrar

- `prompt` (string, obligatorisk)
- `input` (any, valfri)
- `schema` (object, valfritt JSON Schema)
- `provider` (string, valfri)
- `model` (string, valfri)
- `authProfileId` (string, valfri)
- `temperature` (number, valfri)
- `maxTokens` (number, valfri)
- `timeoutMs` (number, valfri)

## Utdata

Returnerar `details.json` som innehåller den tolkade JSON-utdatan (och validerar mot
`schema` när den tillhandahålls).

## Exempel: Lobster-arbetsflödessteg

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

## Säkerhetsnoteringar

- Verktyget är **endast JSON** och instruerar modellen att endast returnera JSON (inga
  kodstaket, inga kommentarer).
- Inga verktyg exponeras för modellen under denna körning.
- Behandla utdata som opålitlig om du inte validerar med `schema`.
- Lägg godkännanden före alla steg som har bieffekter (skicka, posta, exekvera).
