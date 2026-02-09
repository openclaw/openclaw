---
summary: "Tareas de LLM solo JSON para flujos de trabajo (herramienta de complemento opcional)"
read_when:
  - Quiere un paso de LLM solo JSON dentro de flujos de trabajo
  - Necesita salida de LLM validada por esquema para automatización
title: "Tarea de LLM"
---

# Tarea de LLM

`llm-task` es una **herramienta de complemento opcional** que ejecuta una tarea de LLM solo JSON y
devuelve salida estructurada (opcionalmente validada contra JSON Schema).

Esto es ideal para motores de flujos de trabajo como Lobster: puede agregar un único paso de LLM
sin escribir código personalizado de OpenClaw para cada flujo de trabajo.

## Habilitar el complemento

1. Habilite el complemento:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Agregue la herramienta a la lista de permitidos (está registrada con `optional: true`):

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

## Configuración (opcional)

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

`allowedModels` es una lista de permitidos de cadenas `provider/model`. Si se establece, cualquier solicitud
fuera de la lista es rechazada.

## Parámetros de la herramienta

- `prompt` (string, requerido)
- `input` (any, opcional)
- `schema` (object, JSON Schema opcional)
- `provider` (string, opcional)
- `model` (string, opcional)
- `authProfileId` (string, opcional)
- `temperature` (number, opcional)
- `maxTokens` (number, opcional)
- `timeoutMs` (number, opcional)

## Salida

Devuelve `details.json` que contiene el JSON analizado (y valida contra
`schema` cuando se proporciona).

## Ejemplo: paso de flujo de trabajo de Lobster

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

## Notas de seguridad

- La herramienta es **solo JSON** e instruye al modelo a producir únicamente JSON (sin
  cercas de código ni comentarios).
- No se exponen herramientas al modelo para esta ejecución.
- Trate la salida como no confiable a menos que valide con `schema`.
- Coloque aprobaciones antes de cualquier paso con efectos secundarios (enviar, publicar, ejecutar).
