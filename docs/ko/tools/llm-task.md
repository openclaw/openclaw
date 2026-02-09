---
summary: "워크플로를 위한 JSON 전용 LLM 작업 (선택적 플러그인 도구)"
read_when:
  - 워크플로 내에서 JSON 전용 LLM 단계를 원할 때
  - 자동화를 위해 스키마 검증된 LLM 출력이 필요할 때
title: "LLM 작업"
---

# LLM 작업

`llm-task` 는 JSON 전용 LLM 작업을 실행하고 구조화된 출력을 반환하는 **선택적 플러그인 도구**입니다(선택적으로 JSON Schema 에 대해 검증됨).

이는 Lobster 와 같은 워크플로 엔진에 이상적입니다. 각 워크플로마다 사용자 정의 OpenClaw 코드를 작성하지 않고도 단일 LLM 단계를 추가할 수 있습니다.

## 플러그인 활성화

1. 플러그인을 활성화합니다:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. 도구를 허용 목록에 추가합니다(`optional: true` 로 등록되어 있음):

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

## 설정 (선택 사항)

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

`allowedModels` 는 `provider/model` 문자열의 허용 목록입니다. 설정된 경우, 목록 외의 모든 요청은 거부됩니다.

## 도구 매개변수

- `prompt` (string, 필수)
- `input` (any, 선택 사항)
- `schema` (object, 선택 사항, JSON Schema)
- `provider` (string, 선택 사항)
- `model` (string, 선택 사항)
- `authProfileId` (string, 선택 사항)
- `temperature` (number, 선택 사항)
- `maxTokens` (number, 선택 사항)
- `timeoutMs` (number, 선택 사항)

## 출력

파싱된 JSON 을 포함하는 `details.json` 를 반환합니다(제공된 경우 `schema` 에 대해 검증함).

## 예시: Lobster 워크플로 단계

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

## 안전 관련 참고 사항

- 이 도구는 **JSON 전용**이며 모델에 JSON 만 출력하도록 지시합니다(코드 펜스 없음, 해설 없음).
- 이 실행에서는 모델에 어떠한 도구도 노출되지 않습니다.
- `schema` 로 검증하지 않는 한 출력을 신뢰할 수 없는 것으로 취급하십시오.
- 부작용이 있는 단계(send, post, exec) 이전에 승인 단계를 배치하십시오.
