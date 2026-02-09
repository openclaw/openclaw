---
summary: "Mga JSON-only na LLM task para sa workflows (opsyonal na plugin tool)"
read_when:
  - Gusto mo ng JSON-only na LLM step sa loob ng workflows
  - Kailangan mo ng schema-validated na LLM output para sa automation
title: "LLM Task"
---

# LLM Task

`llm-task` ay isang **opsyonal na plugin tool** na nagpapatakbo ng JSON-only na LLM task at
nagbabalik ng structured output (opsyonal na nabe-validate laban sa JSON Schema).

Ito ay mainam para sa mga workflow engine tulad ng Lobster: maaari kang magdagdag ng iisang LLM step
nang hindi nagsusulat ng custom na OpenClaw code para sa bawat workflow.

## I-enable ang plugin

1. I-enable ang plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. I-allowlist ang tool (ito ay naka-register bilang `optional: true`):

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

## Config (opsyonal)

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

40. Ang `allowedModels` ay isang allowlist ng mga string na `provider/model`. 41. Kapag itinakda, anumang request
    sa labas ng listahan ay tinatanggihan.

## Mga parameter ng tool

- `prompt` (string, kinakailangan)
- `input` (anumang uri, opsyonal)
- `schema` (object, opsyonal na JSON Schema)
- `provider` (string, opsyonal)
- `model` (string, opsyonal)
- `authProfileId` (string, opsyonal)
- `temperature` (number, opsyonal)
- `maxTokens` (number, opsyonal)
- `timeoutMs` (number, opsyonal)

## Output

Nagbabalik ng `details.json` na naglalaman ng parsed na JSON (at nabe-validate laban sa
`schema` kapag ibinigay).

## Halimbawa: Lobster workflow step

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

## Mga tala sa kaligtasan

- Ang tool ay **JSON-only** at inuutusan ang model na mag-output ng JSON lamang (walang
  code fences, walang komentaryo).
- Walang mga tool na inilalantad sa model para sa run na ito.
- Ituring ang output bilang hindi pinagkakatiwalaan maliban kung i-validate mo gamit ang `schema`.
- Ilagay ang mga approval bago ang anumang step na may side effect (send, post, exec).
