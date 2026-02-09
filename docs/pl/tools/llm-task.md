---
summary: "„Zadania LLM wyłącznie w JSON do workflow (opcjonalne narzędzie wtyczki)”"
read_when:
  - Chcesz mieć krok LLM wyłącznie w JSON wewnątrz workflow
  - Potrzebujesz wyjścia LLM walidowanego schematem do automatyzacji
title: "„Zadanie LLM”"
---

# Zadanie LLM

`llm-task` to **opcjonalne narzędzie wtyczki**, które uruchamia zadanie LLM wyłącznie w JSON i
zwraca ustrukturyzowane wyjście (opcjonalnie walidowane względem JSON Schema).

Jest to idealne rozwiązanie dla silników workflow, takich jak Lobster: możesz dodać pojedynczy krok LLM
bez pisania niestandardowego kodu OpenClaw dla każdego workflow.

## Włączanie wtyczki

1. Włącz wtyczkę:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Dodaj narzędzie do listy dozwolonych (jest zarejestrowane jako `optional: true`):

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

## Konfiguracja (opcjonalnie)

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

`allowedModels` to lista dozwolonych ciągów `provider/model`. Jeśli jest ustawiona, każde żądanie
spoza listy jest odrzucane.

## Parametry narzędzia

- `prompt` (string, wymagane)
- `input` (dowolny typ, opcjonalne)
- `schema` (obiekt, opcjonalny JSON Schema)
- `provider` (string, opcjonalne)
- `model` (string, opcjonalne)
- `authProfileId` (string, opcjonalne)
- `temperature` (number, opcjonalne)
- `maxTokens` (number, opcjonalne)
- `timeoutMs` (number, opcjonalne)

## Wyjście

Zwraca `details.json` zawierające sparsowany JSON (i waliduje go względem
`schema`, gdy jest podany).

## Przykład: krok workflow Lobster

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

## Uwagi dotyczące bezpieczeństwa

- Narzędzie działa **wyłącznie w JSON** i instruuje model, aby zwracał tylko JSON (bez
  bloków kodu, bez komentarzy).
- Podczas tego uruchomienia żadne narzędzia nie są udostępniane modelowi.
- Traktuj wyjście jako niezaufane, dopóki nie zostanie zwalidowane za pomocą `schema`.
- Umieszczaj zatwierdzenia przed każdym krokiem wywołującym skutki uboczne (send, post, exec).
