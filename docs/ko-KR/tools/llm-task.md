---
summary: "워크플로우용 JSON 전용 LLM 작업 (선택적 플러그인 도구)"
read_when:
  - "워크플로우 내부에서 JSON 전용 LLM 단계를 원할 때"
  - "워크플로우 자동화에 대해 스키마로 검증된 LLM 출력이 필요할 때"
title: "LLM Task"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/tools/llm-task.md
  workflow: 15
---

# LLM Task

`llm-task`는 JSON 전용 LLM 작업을 실행하고 구조화된 출력을 반환하는 **선택적 플러그인 도구** (선택적으로 JSON 스키마에 대해 검증).

이것은 워크플로우 엔진 (예: Lobster)에 이상적입니다: 각 워크플로우에 대한 커스텀 OpenClaw 코드를 작성하지 않고 단일 LLM 단계를 추가할 수 있습니다.

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

2. 도구를 allowlist합니다 (`optional: true`로 등록):

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

## 구성 (선택)

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

`allowedModels`는 `provider/model` 문자열의 allowlist입니다. 설정되면 목록 외부의 요청은 거부됩니다.

## 도구 파라미터

- `prompt` (문자열, 필수)
- `input` (any, 선택)
- `schema` (객체, 선택 JSON 스키마)
- `provider` (문자열, 선택)
- `model` (문자열, 선택)
- `authProfileId` (문자열, 선택)
- `temperature` (숫자, 선택)
- `maxTokens` (숫자, 선택)
- `timeoutMs` (숫자, 선택)

## 출력

`details.json`을 포함하는 파싱된 JSON을 반환합니다 (제공되면 `schema`에 대해 검증).

## 예: Lobster 워크플로우 단계

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

## 안전 메모

- 도구는 **JSON 전용**이고 모델에 JSON만 출력하도록 지시합니다 (코드 펜스 없음, 설명 없음).
- 이 실행에 대해서는 모델에 도구를 노출하지 않습니다.
- `schema`로 검증하지 않으면 출력을 신뢰할 수 없는 것으로 취급합니다.
- 모든 부작용 단계 (전송, 게시, 실행) 전에 승인을 넣습니다.
