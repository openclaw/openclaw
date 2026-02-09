---
summary: "Tarefas de LLM apenas em JSON para workflows (ferramenta de plugin opcional)"
read_when:
  - Você quer uma etapa de LLM apenas em JSON dentro de workflows
  - Você precisa de saída de LLM validada por esquema para automação
title: "Tarefa de LLM"
---

# Tarefa de LLM

`llm-task` é uma **ferramenta de plugin opcional** que executa uma tarefa de LLM apenas em JSON e
retorna saída estruturada (opcionalmente validada contra um JSON Schema).

Isso é ideal para mecanismos de workflow como o Lobster: você pode adicionar uma única etapa de LLM
sem escrever código OpenClaw personalizado para cada workflow.

## Habilitar o plugin

1. Habilite o plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Coloque a ferramenta na lista de permissões (ela é registrada com `optional: true`):

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

## Configuração (opcional)

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

`allowedModels` é uma lista de permissões de strings `provider/model`. Se definida, qualquer solicitação
fora da lista é rejeitada.

## Parâmetros da ferramenta

- `prompt` (string, obrigatório)
- `input` (qualquer, opcional)
- `schema` (objeto, JSON Schema opcional)
- `provider` (string, opcional)
- `model` (string, opcional)
- `authProfileId` (string, opcional)
- `temperature` (número, opcional)
- `maxTokens` (número, opcional)
- `timeoutMs` (número, opcional)

## Saída

Retorna `details.json` contendo o JSON analisado (e valida contra
`schema` quando fornecido).

## Exemplo: etapa de workflow do Lobster

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

## Notas de segurança

- A ferramenta é **apenas em JSON** e instrui o modelo a produzir somente JSON (sem
  cercas de código, sem comentários).
- Nenhuma ferramenta é exposta ao modelo nesta execução.
- Trate a saída como não confiável, a menos que você valide com `schema`.
- Coloque aprovações antes de qualquer etapa com efeitos colaterais (enviar, postar, executar).
