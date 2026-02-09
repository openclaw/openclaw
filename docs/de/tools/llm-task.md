---
summary: "Ausschließlich-JSON-LLM-Aufgaben für Workflows (optionales Plugin-Werkzeug)"
read_when:
  - Sie möchten einen ausschließlich-JSON-LLM-Schritt innerhalb von Workflows
  - Sie benötigen schema-validierte LLM-Ausgaben für Automatisierung
title: "LLM-Aufgabe"
---

# LLM-Aufgabe

`llm-task` ist ein **optionales Plugin-Werkzeug**, das eine ausschließlich-JSON-LLM-Aufgabe ausführt und
strukturierte Ausgaben zurückgibt (optional gegen JSON Schema validiert).

Dies ist ideal für Workflow-Engines wie Lobster: Sie können einen einzelnen LLM-Schritt hinzufügen,
ohne für jeden Workflow benutzerdefinierten OpenClaw-Code zu schreiben.

## Plugin aktivieren

1. Aktivieren Sie das Plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Setzen Sie das Werkzeug auf die Allowlist (es ist mit `optional: true` registriert):

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

## Konfiguration (optional)

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

`allowedModels` ist eine Allowlist von `provider/model`-Strings. Falls gesetzt, wird jede Anfrage
außerhalb der Liste abgelehnt.

## Werkzeugparameter

- `prompt` (string, erforderlich)
- `input` (any, optional)
- `schema` (object, optionales JSON Schema)
- `provider` (string, optional)
- `model` (string, optional)
- `authProfileId` (string, optional)
- `temperature` (number, optional)
- `maxTokens` (number, optional)
- `timeoutMs` (number, optional)

## Ausgabe

Gibt `details.json` zurück, das das geparste JSON enthält (und validiert es gegen
`schema`, sofern bereitgestellt).

## Beispiel: Lobster-Workflow-Schritt

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

## Sicherheitshinweise

- Das Werkzeug ist **ausschließlich JSON** und weist das Modell an, nur JSON auszugeben (keine
  Code-Fences, keine Kommentare).
- Für diesen Lauf werden dem Modell keine Werkzeuge bereitgestellt.
- Behandeln Sie die Ausgabe als nicht vertrauenswürdig, sofern Sie nicht mit `schema` validieren.
- Platzieren Sie Genehmigungen vor jedem Schritt mit Seiteneffekten (senden, posten, ausführen).
