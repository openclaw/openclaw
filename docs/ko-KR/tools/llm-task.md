---
summary: "JSON-only LLM tasks for workflows (optional plugin tool)"
read_when:
  - You want a JSON-only LLM step inside workflows
  - You need schema-validated LLM output for automation
title: "LLM Task"
---

# LLM Task

`llm-task`는 JSON-only LLM 작업을 실행하고 구조화된 출력을 반환하는 **옵션 플러그인 도구**입니다 (선택적으로 JSON 스키마에 대해 유효성을 검사할 수 있음).

이는 Lobster 같은 워크플로 엔진에 이상적입니다. 각 워크플로에 대해 맞춤형 OpenClaw 코드를 작성하지 않고도 단일 LLM 단계를 추가할 수 있습니다.

## Enable the plugin

1. Enable the plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Allowlist the tool (it is registered with `optional: true`):

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

## Config (optional)

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

`allowedModels`는 `provider/model` 문자열의 허용 목록입니다. 설정된 경우, 목록 외의 요청은 거부됩니다.

## Tool parameters

- `prompt` (string, required)
- `input` (any, optional)
- `schema` (object, optional JSON Schema)
- `provider` (string, optional)
- `model` (string, optional)
- `authProfileId` (string, optional)
- `temperature` (number, optional)
- `maxTokens` (number, optional)
- `timeoutMs` (number, optional)

## Output

파싱된 JSON을 포함하는 `details.json`을 반환하며, 제공된 경우 `schema`에 대해 유효성을 검사합니다.

## Example: Lobster workflow step

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

## Safety notes

- 이 도구는 **JSON-only**이며 모델에게 JSON만 출력하도록 지시합니다 (코드 펜스 없음, 주석 없음).
- 이 실행에서 모델에 노출되는 도구는 없습니다.
- `schema`로 유효성을 검사하지 않는 한 출력 결과를 신뢰하지 마십시오.
- 부작용이 있는 단계(발송, 게시, 실행) 전에 승인을 설정하십시오.